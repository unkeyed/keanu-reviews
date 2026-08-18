import type { InstallationAuth } from "./auth.ts";

const GITHUB_API_BASE = "https://api.github.com";
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

export interface GithubRequestOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * Perform an authenticated GitHub JSON GET with bounded latency and consistent
 * error semantics. A 404 is the only HTTP response represented as absence.
 */
export async function githubGetJson<T>(
  auth: InstallationAuth,
  installationId: string,
  path: string,
  options: GithubRequestOptions = {},
): Promise<T | undefined> {
  const url = `${GITHUB_API_BASE}${path}`;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const request = async (token: string): Promise<Response> => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await fetchFn(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "keanu-reviews",
        },
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
    auth.invalidate(installationId);
    token = await auth.getToken(installationId);
    response = await request(token);
  }

  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new GithubApiError(`GitHub API returned HTTP ${response.status}`, {
      kind: "http",
      status: response.status,
      url,
    });
  }

  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new GithubApiError("GitHub API returned invalid JSON", {
      kind: "invalid_response",
      status: response.status,
      url,
      cause,
    });
  }
}

/**
 * Perform an authenticated GitHub JSON POST. This is the ONLY write path in the
 * service and is used exclusively behind the opt-in merge-comment feature; the
 * one-way boundary otherwise holds. A 403 typically means the GitHub App lacks
 * the write permission (grant it and reinstall).
 */
export async function githubPostJson(
  auth: InstallationAuth,
  installationId: string,
  path: string,
  body: unknown,
  options: GithubRequestOptions = {},
): Promise<void> {
  const url = `${GITHUB_API_BASE}${path}`;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const request = async (token: string): Promise<Response> => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "keanu-reviews",
        },
        body: JSON.stringify(body),
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
    auth.invalidate(installationId);
    token = await auth.getToken(installationId);
    response = await request(token);
  }

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
