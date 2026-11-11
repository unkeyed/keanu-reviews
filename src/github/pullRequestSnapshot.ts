import type { PrSnapshot } from "#events";
import type { InstallationAuth } from "./auth.ts";
import {
  GithubApiError,
  type GithubRequestOptions,
  encodedRepoPath,
  githubRequest,
  headerNumber,
  rateLimitOf,
} from "./http.ts";

export type PullRequestSnapshot = PrSnapshot & { state: "open" | "closed"; merged: boolean };

export interface PullRequestSnapshotFetch {
  snapshot: PullRequestSnapshot | undefined;
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

function parseSnapshot(
  body: unknown,
  repo: string,
  path: string,
  expectedNumber: number,
): PullRequestSnapshot {
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
    repo,
    number: expectedNumber,
    githubPrId: pr.id as number,
    title: pr.title,
    url: pr.html_url,
    author: { id: pr.user.id as number, login: pr.user.login, isBot: pr.user.type === "Bot" },
    draft: pr.draft === true,
    headSha: pr.head.sha,
    headRef: typeof pr.head.ref === "string" ? pr.head.ref : undefined,
    baseRef: typeof pr.base?.ref === "string" ? pr.base.ref : undefined,
    updatedAt: pr.updated_at,
    requestedReviewers: [],
    state: pr.state,
    merged: pr.merged,
  };
}

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
    return { ...fetched, snapshot: parseSnapshot(body, repoFullName, path, number) };
  };
}
