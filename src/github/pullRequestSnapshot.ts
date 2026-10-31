import type { Logger } from "../logger.ts";
import type { InstallationAuth } from "./auth.ts";
import {
  GithubApiError,
  type GithubRequestOptions,
  encodedRepoPath,
  githubRequest,
} from "./http.ts";

/** A GitHub rate limit we will not wait out. The reconciliation run stops cleanly. */
export class GithubRateLimitExhaustedError extends Error {
  readonly retryAfterMs?: number;
  readonly resetAtMs?: number;

  constructor(message: string, details: { retryAfterMs?: number; resetAtMs?: number } = {}) {
    super(message);
    this.name = "GithubRateLimitExhaustedError";
    this.retryAfterMs = details.retryAfterMs;
    this.resetAtMs = details.resetAtMs;
  }
}

/** Pull request facts the reconciliation job needs to replay a close or merge. */
export interface PullRequestSnapshot {
  id: number;
  number: number;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  title: string;
  htmlUrl: string;
  updatedAt: string;
  user: { id: number; login: string };
  headSha: string;
  headRef?: string;
  baseRef?: string;
}

export interface PullRequestSnapshotFetch {
  /** Undefined when GitHub returns 404. */
  snapshot: PullRequestSnapshot | undefined;
  /** `x-ratelimit-remaining` after this response, when GitHub sent it. */
  remaining?: number;
}

export type PullRequestSnapshotFetcher = (
  repoFullName: string,
  number: number,
) => Promise<PullRequestSnapshotFetch>;

export interface PullRequestSnapshotFetcherOptions extends GithubRequestOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Wait at most this long for a single Retry-After or rate-limit reset. */
  maxBackoffMs?: number;
  /** How many times to back off and retry one PR before stopping the run. */
  maxRateLimitRetries?: number;
  logger?: Logger;
}

/** Two minutes: long enough to honor a short Retry-After, short enough to stop a daily run. */
const DEFAULT_MAX_BACKOFF_MS = 120_000;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RateLimitHeaders {
  remaining?: number;
  resetEpochSec?: number;
  retryAfterSec?: number;
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function readRateLimit(headers: Headers): RateLimitHeaders {
  return {
    remaining: headerNumber(headers, "x-ratelimit-remaining"),
    resetEpochSec: headerNumber(headers, "x-ratelimit-reset"),
    retryAfterSec: headerNumber(headers, "retry-after"),
  };
}

function backoffMs(limit: RateLimitHeaders, nowMs: number): number | undefined {
  if (limit.retryAfterSec !== undefined) return Math.ceil(limit.retryAfterSec * 1000);
  if (limit.remaining === 0 && limit.resetEpochSec !== undefined) {
    return Math.max(0, Math.ceil(limit.resetEpochSec * 1000 - nowMs));
  }
  return undefined;
}

function isRateLimited(status: number, limit: RateLimitHeaders, body: string): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  if (limit.retryAfterSec !== undefined || limit.remaining === 0) return true;
  return /rate limit/i.test(body);
}

function invalidResponse(path: string): GithubApiError {
  return new GithubApiError("GitHub API returned an unexpected pull request", {
    kind: "invalid_response",
    url: `https://api.github.com${path}`,
  });
}

function parseSnapshot(body: unknown, path: string, expectedNumber: number): PullRequestSnapshot {
  if (typeof body !== "object" || body === null) throw invalidResponse(path);
  const pr = body as {
    id?: unknown;
    number?: unknown;
    state?: unknown;
    merged?: unknown;
    draft?: unknown;
    title?: unknown;
    html_url?: unknown;
    updated_at?: unknown;
    user?: { id?: unknown; login?: unknown };
    head?: { sha?: unknown; ref?: unknown };
    base?: { ref?: unknown };
  };
  if (!Number.isInteger(pr.id) || pr.number !== expectedNumber) throw invalidResponse(path);
  if (pr.state !== "open" && pr.state !== "closed") throw invalidResponse(path);
  if (typeof pr.merged !== "boolean") throw invalidResponse(path);
  if (typeof pr.title !== "string" || pr.title.length === 0) throw invalidResponse(path);
  if (typeof pr.html_url !== "string" || pr.html_url.length === 0) throw invalidResponse(path);
  if (typeof pr.updated_at !== "string" || Number.isNaN(Date.parse(pr.updated_at))) {
    throw invalidResponse(path);
  }
  if (!Number.isInteger(pr.user?.id) || typeof pr.user?.login !== "string" || !pr.user.login) {
    throw invalidResponse(path);
  }
  if (typeof pr.head?.sha !== "string" || pr.head.sha.length === 0) throw invalidResponse(path);
  return {
    id: pr.id as number,
    number: expectedNumber,
    state: pr.state,
    merged: pr.merged,
    draft: pr.draft === true,
    title: pr.title,
    htmlUrl: pr.html_url,
    updatedAt: pr.updated_at,
    user: { id: pr.user.id as number, login: pr.user.login },
    headSha: pr.head.sha,
    headRef: typeof pr.head.ref === "string" ? pr.head.ref : undefined,
    baseRef: typeof pr.base?.ref === "string" ? pr.base.ref : undefined,
  };
}

/**
 * Read one PR from GitHub, honoring primary and secondary rate limits.
 * Backs off on Retry-After (or the reset time when remaining is 0) up to a cap,
 * then throws {@link GithubRateLimitExhaustedError} so the caller can stop.
 * Calls are independent — remaining is reported, not remembered — so a later run
 * starts fresh after the limit window resets.
 */
export function createPullRequestSnapshotFetcher(
  auth: InstallationAuth,
  installationId: string,
  options: PullRequestSnapshotFetcherOptions = {},
): PullRequestSnapshotFetcher {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;

  return async (repoFullName, number) => {
    const path = `/repos/${encodedRepoPath(repoFullName)}/pulls/${number}`;
    let rateLimitRetries = 0;

    for (;;) {
      const response = await githubRequest(auth, installationId, path, options);
      const limit = readRateLimit(response.headers);
      const text = await response.text();

      if (isRateLimited(response.status, limit, text)) {
        const waitMs = backoffMs(limit, now());
        const resetAtMs =
          limit.resetEpochSec !== undefined ? limit.resetEpochSec * 1000 : undefined;
        const withinBudget =
          waitMs !== undefined && waitMs <= maxBackoffMs && rateLimitRetries < maxRateLimitRetries;
        if (!withinBudget) {
          throw new GithubRateLimitExhaustedError(
            waitMs === undefined
              ? "GitHub rate limit exceeded and no retry delay was provided"
              : `GitHub rate limit exceeded; retry after ${waitMs}ms is outside the backoff budget`,
            { retryAfterMs: waitMs, resetAtMs },
          );
        }
        rateLimitRetries += 1;
        options.logger?.info("GitHub rate limit backoff", {
          repoFullName,
          number,
          waitMs,
          attempt: rateLimitRetries,
        });
        await sleep(waitMs);
        continue;
      }

      if (response.status === 404) return { snapshot: undefined, remaining: limit.remaining };
      if (!response.ok) {
        throw new GithubApiError(`GitHub API returned HTTP ${response.status}`, {
          kind: "http",
          status: response.status,
          url: `https://api.github.com${path}`,
        });
      }

      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch (cause) {
        throw new GithubApiError("GitHub API returned invalid JSON", {
          kind: "invalid_response",
          status: response.status,
          url: `https://api.github.com${path}`,
          cause,
        });
      }
      return { snapshot: parseSnapshot(body, path, number), remaining: limit.remaining };
    }
  };
}
