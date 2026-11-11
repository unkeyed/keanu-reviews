import { RateLimited } from "#lib";
import type { InstallationAuth } from "./auth.ts";

const GITHUB_API_BASE = "https://api.github.com";

export const GITHUB_ROUTES = [
  "GET /repos/{owner}/{repo}/pulls/{number}",
  "GET /repos/{owner}/{repo}/pulls/{number}/reviews",
  "GET /repos/{owner}/{repo}/commits/{sha}/check-runs",
  "GET /repos/{owner}/{repo}/commits/{sha}/pulls",
  "GET /users/{login}",
  "POST /repos/{owner}/{repo}/issues/{number}/comments",
  "POST /app/installations/{installation_id}/access_tokens",
  "GET /user",
  "GET https://github.com/login/oauth/authorize",
  "POST https://github.com/login/oauth/access_token",
] as const;
const DEFAULT_TIMEOUT_MS = 10_000;

export type GithubApiErrorKind = "http" | "timeout" | "network" | "invalid_response";

export class GithubApiError extends Error {
  readonly kind: GithubApiErrorKind;
  readonly status?: number;
  readonly url: string;

  constructor(
    message: string,
    options: { kind: GithubApiErrorKind; url: string; status?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "GithubApiError";
    this.kind = options.kind;
    this.status = options.status;
    this.url = options.url;
  }
}

export function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * A 403 or 429 that is a GitHub rate limit, as a retry at the time GitHub
 * names: `retry-after` for a secondary limit, or `x-ratelimit-reset` once
 * `x-ratelimit-remaining` hits 0. Pass the body when it was read, since a
 * secondary limit can say so only there.
 */
export function rateLimitOf(
  response: Response,
  url: string,
  body?: string,
): RateLimited | undefined {
  const { status, headers } = response;
  if (status !== 403 && status !== 429) return undefined;
  const retryAfterSec = headerNumber(headers, "retry-after");
  const remaining = headerNumber(headers, "x-ratelimit-remaining");
  const resetSec = headerNumber(headers, "x-ratelimit-reset");
  const limited =
    retryAfterSec !== undefined ||
    remaining === 0 ||
    (body !== undefined && /rate limit/i.test(body));
  if (!limited) return undefined;
  const retryAfterMs =
    retryAfterSec !== undefined
      ? Math.ceil(retryAfterSec * 1000)
      : remaining === 0 && resetSec !== undefined
        ? Math.max(0, Math.ceil(resetSec * 1000 - Date.now()))
        : undefined;
  return new RateLimited(`GitHub rate limit exceeded (HTTP ${status})`, { url }, retryAfterMs);
}

export function encodedRepoPath(repoFullName: string): string {
  return repoFullName.split("/").map(encodeURIComponent).join("/");
}

export interface GithubRequestOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface GithubRequestOptionsWithBody extends GithubRequestOptions {
  method?: "GET" | "POST";
  jsonBody?: unknown;
}

export async function githubRequest(
  auth: InstallationAuth,
  installationId: string,
  path: string,
  options: GithubRequestOptionsWithBody = {},
): Promise<Response> {
  const url = `${GITHUB_API_BASE}${path}`;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const method = options.method ?? "GET";

  const request = async (token: string): Promise<Response> => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await fetchFn(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "keanu-reviews",
          ...(options.jsonBody !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: options.jsonBody !== undefined ? JSON.stringify(options.jsonBody) : undefined,
        signal,
      });
    } catch (cause) {
      if (signal.aborted) {
        throw new GithubApiError(`GitHub request timed out after ${timeoutMs}ms`, {
          kind: "timeout",
          url,
          cause,
        });
      }
      throw new GithubApiError("GitHub request failed", { kind: "network", url, cause });
    }
  };

  let token = await auth.getToken(installationId);
  let response = await request(token);
  if (response.status === 401) {
    await response.body?.cancel();
    auth.invalidate(installationId);
    token = await auth.getToken(installationId);
    response = await request(token);
  }
  return response;
}

export async function githubGetJson<T>(
  auth: InstallationAuth,
  installationId: string,
  path: string,
  options: GithubRequestOptions = {},
): Promise<T | undefined> {
  const url = `${GITHUB_API_BASE}${path}`;
  const response = await githubRequest(auth, installationId, path, options);

  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  const rateLimit = rateLimitOf(response, url);
  if (rateLimit) {
    await response.body?.cancel();
    throw rateLimit;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new GithubApiError(`GitHub API returned HTTP ${response.status}`, {
      kind: "http",
      status: response.status,
      url,
    });
  }

  try {
    return (await response.json()) as T;
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      throw new GithubApiError(`GitHub request timed out after ${timeoutMs}ms`, {
        kind: "timeout",
        status: response.status,
        url,
        cause,
      });
    }
    throw new GithubApiError("GitHub API returned invalid JSON", {
      kind: "invalid_response",
      status: response.status,
      url,
      cause,
    });
  }
}

export async function githubPostJson(
  auth: InstallationAuth,
  installationId: string,
  path: string,
  body: unknown,
  options: GithubRequestOptions = {},
): Promise<void> {
  const url = `${GITHUB_API_BASE}${path}`;
  const response = await githubRequest(auth, installationId, path, {
    ...options,
    method: "POST",
    jsonBody: body,
  });
  await response.body?.cancel();

  const rateLimit = rateLimitOf(response, url);
  if (rateLimit) throw rateLimit;
  if (!response.ok) {
    const hint =
      response.status === 403
        ? " (the GitHub App likely lacks write permission — grant Pull requests / Issues write and reinstall)"
        : "";
    throw new GithubApiError(`GitHub API returned HTTP ${response.status}${hint}`, {
      kind: "http",
      status: response.status,
      url,
    });
  }
}
