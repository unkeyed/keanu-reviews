import type { GithubActor, PrSnapshot } from "#events";
import type { InstallationAuth } from "./auth.ts";
import {
  GithubApiError,
  type GithubRequestOptions,
  encodedRepoPath,
  githubRequest,
  headerNumber,
  rateLimitOf,
} from "./http.ts";

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
  user: GithubActor;
  headSha: string;
  headRef?: string;
  baseRef?: string;
}

/** GitHub's REST view of a PR in `repo`, as the domain snapshot a webhook also carries. */
export function toPrSnapshot(repo: string, snapshot: PullRequestSnapshot): PrSnapshot {
  return {
    repo,
    number: snapshot.number,
    githubPrId: snapshot.id,
    title: snapshot.title,
    url: snapshot.htmlUrl,
    author: snapshot.user,
    draft: snapshot.draft,
    headSha: snapshot.headSha,
    headRef: snapshot.headRef,
    baseRef: snapshot.baseRef,
    updatedAt: snapshot.updatedAt,
    requestedReviewers: [],
  };
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
    user?: { id?: unknown; login?: unknown; type?: unknown };
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
    user: { id: pr.user.id as number, login: pr.user.login, isBot: pr.user.type === "Bot" },
    headSha: pr.head.sha,
    headRef: typeof pr.head.ref === "string" ? pr.head.ref : undefined,
    baseRef: typeof pr.base?.ref === "string" ? pr.base.ref : undefined,
  };
}

/**
 * Read one PR from GitHub. A rate limit throws `RateLimited` at once with
 * GitHub's wait: a job retries at the reset, and the daily reconcile decides
 * itself whether to wait or stop.
 */
export function createPullRequestSnapshotFetcher(
  auth: InstallationAuth,
  installationId: string,
  options: GithubRequestOptions = {},
): PullRequestSnapshotFetcher {
  return async (repoFullName, number) => {
    const path = `/repos/${encodedRepoPath(repoFullName)}/pulls/${number}`;
    const url = `https://api.github.com${path}`;
    const response = await githubRequest(auth, installationId, path, options);
    const text = await response.text();
    const rateLimit = rateLimitOf(response, url, text);
    if (rateLimit) throw rateLimit;
    const fetched = { remaining: headerNumber(response.headers, "x-ratelimit-remaining") };
    if (response.status === 404) return { ...fetched, snapshot: undefined };
    if (!response.ok) {
      throw new GithubApiError(`GitHub API returned HTTP ${response.status}`, {
        kind: "http",
        status: response.status,
        url,
      });
    }

    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch (cause) {
      throw new GithubApiError("GitHub API returned invalid JSON", {
        kind: "invalid_response",
        status: response.status,
        url,
        cause,
      });
    }
    return { ...fetched, snapshot: parseSnapshot(body, path, number) };
  };
}
