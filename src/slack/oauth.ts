/**
 * Slack user-token OAuth (v2). The GitHub OAuth flow proves identity and throws
 * the token away; this flow instead persists each participant's user token so
 * the bot can call `conversations.leave` on their behalf and archive PR channels
 * silently. Signed CSRF state is shared with the GitHub flow (see github/oauth).
 */
const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const ACCESS_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const DEFAULT_TIMEOUT_MS = 10_000;

/** User scope needed to leave a public channel via `conversations.leave`. */
export const SLACK_LEAVE_USER_SCOPE = "channels:write";
/** User scope needed to post a mirrored comment/review as the user themselves. */
export const SLACK_POST_USER_SCOPE = "chat:write";
/** All user scopes `/link-slack` requests: quiet-archive leave + authoring posts. */
export const SLACK_USER_SCOPES = `${SLACK_LEAVE_USER_SCOPE},${SLACK_POST_USER_SCOPE}`;

/** True when a Slack-granted scope string (space/comma separated) contains `required`. */
export function hasScope(granted: string, required: string): boolean {
  return granted
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .includes(required);
}

export function createSlackAuthorizeUrl(input: {
  clientId: string;
  callbackUrl: string;
  state: string;
  userScopes?: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.callbackUrl);
  url.searchParams.set("state", input.state);
  // Request only user scopes — the bot token is provisioned separately at install.
  url.searchParams.set("user_scope", input.userScopes ?? SLACK_USER_SCOPES);
  url.searchParams.set("scope", "");
  return url.toString();
}

export type SlackOAuthErrorKind = "exchange" | "response" | "timeout" | "network";

export class SlackOAuthError extends Error {
  readonly kind: SlackOAuthErrorKind;
  readonly slackError?: string;

  constructor(kind: SlackOAuthErrorKind, slackError?: string, cause?: unknown) {
    super("Slack OAuth authentication failed", { cause });
    this.name = "SlackOAuthError";
    this.kind = kind;
    this.slackError = slackError;
  }
}

export interface SlackOAuthResult {
  authedUserId: string;
  accessToken: string;
  scope: string;
  teamId: string;
}

export interface SlackOAuthClient {
  exchangeCode(input: { code: string; callbackUrl: string }): Promise<SlackOAuthResult>;
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
    throw new SlackOAuthError(signal.aborted ? "timeout" : "network", undefined, cause);
  }
}

export function createSlackOAuthClient(input: {
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): SlackOAuthClient {
  const fetchFn = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async exchangeCode(authInput) {
      const response = await boundedFetch(
        fetchFn,
        ACCESS_TOKEN_URL,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
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
      // Slack returns HTTP 200 with `{ ok: false, error }` for logical failures.
      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        throw new SlackOAuthError("exchange", undefined, cause);
      }
      if (typeof body !== "object" || body === null) {
        throw new SlackOAuthError("response");
      }
      const payload = body as {
        ok?: unknown;
        error?: unknown;
        authed_user?: {
          id?: unknown;
          access_token?: unknown;
          scope?: unknown;
          token_type?: unknown;
        };
        team?: { id?: unknown };
      };
      if (payload.ok !== true) {
        throw new SlackOAuthError(
          "exchange",
          typeof payload.error === "string" ? payload.error : undefined,
        );
      }
      const authedUserId = payload.authed_user?.id;
      const accessToken = payload.authed_user?.access_token;
      const scope = payload.authed_user?.scope;
      const teamId = payload.team?.id;
      if (
        typeof authedUserId !== "string" ||
        !authedUserId ||
        typeof accessToken !== "string" ||
        !accessToken.startsWith("xox") ||
        typeof teamId !== "string" ||
        !teamId
      ) {
        throw new SlackOAuthError("response");
      }
      return {
        authedUserId,
        accessToken,
        scope: typeof scope === "string" ? scope : "",
        teamId,
      };
    },
  };
}
