import { createHmac, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const AUTHENTICATED_USER_URL = "https://api.github.com/user";
const DEFAULT_TIMEOUT_MS = 10_000;
const STATE_TTL_MS = 10 * 60_000;
const MAX_STATE_LENGTH = 2_048;
const ID_PATTERN = /^[A-Z][A-Z0-9]{1,30}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface OAuthStatePayload {
  version: 1;
  slackUserId: string;
  slackTeamId: string;
  expiresAt: number;
  nonce: string;
}

interface StateClockDeps {
  now?: () => number;
}

export interface CreateOAuthStateInput extends StateClockDeps {
  secret: string;
  slackUserId: string;
  slackTeamId: string;
  randomBytes?: (size: number) => Buffer;
}

export function createOAuthState(input: CreateOAuthStateInput): string {
  const now = (input.now ?? Date.now)();
  const payload: OAuthStatePayload = {
    version: 1,
    slackUserId: input.slackUserId,
    slackTeamId: input.slackTeamId,
    expiresAt: now + STATE_TTL_MS,
    nonce: (input.randomBytes ?? cryptoRandomBytes)(16).toString("base64url"),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", input.secret)
    .update(encodedPayload, "utf8")
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

export function verifyOAuthState(input: {
  state: string;
  secret: string;
  expectedSlackTeamId: string;
  now?: () => number;
}): OAuthStatePayload | undefined {
  if (input.state.length === 0 || input.state.length > MAX_STATE_LENGTH) return undefined;
  const parts = input.state.split(".");
  if (parts.length !== 2) return undefined;
  const [encodedPayload, encodedSignature] = parts;
  if (
    !encodedPayload ||
    !encodedSignature ||
    !BASE64URL_PATTERN.test(encodedPayload) ||
    !BASE64URL_PATTERN.test(encodedSignature)
  ) {
    return undefined;
  }

  const expected = createHmac("sha256", input.secret).update(encodedPayload, "utf8").digest();
  const provided = Buffer.from(encodedSignature, "base64url");
  if (
    provided.toString("base64url") !== encodedSignature ||
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return undefined;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as Partial<OAuthStatePayload>;
  if (
    candidate.version !== 1 ||
    typeof candidate.slackUserId !== "string" ||
    !ID_PATTERN.test(candidate.slackUserId) ||
    typeof candidate.slackTeamId !== "string" ||
    !ID_PATTERN.test(candidate.slackTeamId) ||
    candidate.slackTeamId !== input.expectedSlackTeamId ||
    !Number.isSafeInteger(candidate.expiresAt) ||
    typeof candidate.nonce !== "string" ||
    !BASE64URL_PATTERN.test(candidate.nonce)
  ) {
    return undefined;
  }
  const now = (input.now ?? Date.now)();
  if ((candidate.expiresAt as number) <= now) return undefined;
  return candidate as OAuthStatePayload;
}

export function createGithubAuthorizeUrl(input: {
  clientId: string;
  callbackUrl: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.callbackUrl);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export type GithubOAuthErrorKind = "exchange" | "user" | "timeout" | "network";

export class GithubOAuthError extends Error {
  readonly kind: GithubOAuthErrorKind;
  readonly status?: number;

  constructor(kind: GithubOAuthErrorKind, status?: number, cause?: unknown) {
    super("GitHub OAuth authentication failed", { cause });
    this.name = "GithubOAuthError";
    this.kind = kind;
    this.status = status;
  }
}

export interface GithubOAuthClient {
  authenticate(input: { code: string; callbackUrl: string }): Promise<{
    id: number;
    login: string;
  }>;
}

async function boundedFetch(
  fetchFn: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal });
  } catch (cause) {
    throw new GithubOAuthError(signal.aborted ? "timeout" : "network", undefined, cause);
  }
}

async function readJson(response: Response, kind: "exchange" | "user"): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new GithubOAuthError(kind, response.status, cause);
  }
}

export function createGithubOAuthClient(input: {
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): GithubOAuthClient {
  const fetchFn = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async authenticate(authInput) {
      const exchangeResponse = await boundedFetch(
        fetchFn,
        ACCESS_TOKEN_URL,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "unkey-slack-pr-bot",
          },
          body: new URLSearchParams({
            client_id: input.clientId,
            client_secret: input.clientSecret,
            code: authInput.code,
            redirect_uri: authInput.callbackUrl,
          }),
        },
        timeoutMs,
      );
      if (!exchangeResponse.ok) {
        throw new GithubOAuthError("exchange", exchangeResponse.status);
      }
      const exchangeBody = await readJson(exchangeResponse, "exchange");
      const accessToken =
        typeof exchangeBody === "object" && exchangeBody !== null
          ? (exchangeBody as { access_token?: unknown }).access_token
          : undefined;
      if (typeof accessToken !== "string" || accessToken.length === 0) {
        throw new GithubOAuthError("exchange", exchangeResponse.status);
      }

      const userResponse = await boundedFetch(
        fetchFn,
        AUTHENTICATED_USER_URL,
        {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${accessToken}`,
            "user-agent": "unkey-slack-pr-bot",
            "x-github-api-version": "2022-11-28",
          },
        },
        timeoutMs,
      );
      if (!userResponse.ok) throw new GithubOAuthError("user", userResponse.status);
      const userBody = await readJson(userResponse, "user");
      const id =
        typeof userBody === "object" && userBody !== null
          ? (userBody as { id?: unknown }).id
          : undefined;
      const login =
        typeof userBody === "object" && userBody !== null
          ? (userBody as { login?: unknown }).login
          : undefined;
      if (!Number.isSafeInteger(id) || (id as number) <= 0 || typeof login !== "string" || !login) {
        throw new GithubOAuthError("user", userResponse.status);
      }
      return { id: id as number, login };
    },
  };
}
