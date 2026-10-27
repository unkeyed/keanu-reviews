import {
  type CiCheckRun,
  type CiCheckSuite,
  type CiCommitStatus,
  type CiReadiness,
  type PrForShaFetcher,
  classifyCiReadiness,
} from "../ci/status.ts";
import type { PullRequestFetcher } from "../handlers/mergeability.ts";
import type { GithubUserFetcher } from "../identity/link.ts";
import type { GithubEmailFetcher } from "../identity/resolve.ts";
import type { Logger } from "../logger.ts";
import type { InstallationAuth } from "./auth.ts";
import { GithubApiError, type GithubRequestOptions, githubGetJson } from "./http.ts";

export { GithubApiError } from "./http.ts";

type GithubUserResponse = { id?: unknown; login?: unknown };
type GithubEmailResponse = { email?: unknown };

function invalidResponse(path: string): GithubApiError {
  return new GithubApiError("GitHub API returned an unexpected response shape", {
    kind: "invalid_response",
    url: `https://api.github.com${path}`,
  });
}

/**
 * Production GitHub email fetcher (U5). Reads a user's public profile via
 * `GET /users/{login}`. This is a read — it never writes to GitHub, so it stays
 * within the one-way boundary (R10). Returns undefined when the email is private.
 */
export function createGithubEmailFetcher(
  auth: InstallationAuth,
  installationId: string,
  options: GithubRequestOptions = {},
): GithubEmailFetcher {
  return async (login: string): Promise<string | undefined> => {
    const path = `/users/${encodeURIComponent(login)}`;
    const body = await githubGetJson<GithubEmailResponse>(auth, installationId, path, options);
    if (body === undefined) return undefined;
    if (body.email === null) return undefined;
    if (typeof body.email !== "string") throw invalidResponse(path);
    return body.email;
  };
}

/** Production GitHub user fetcher (U9): resolve a login to its immutable id. */
export function createGithubUserFetcher(
  auth: InstallationAuth,
  installationId: string,
  options: GithubRequestOptions = {},
): GithubUserFetcher {
  return async (login: string) => {
    const path = `/users/${encodeURIComponent(login)}`;
    const body = await githubGetJson<GithubUserResponse>(auth, installationId, path, options);
    if (body === undefined) return undefined;
    if (!Number.isInteger(body.id) || typeof body.login !== "string" || body.login.length === 0) {
      throw invalidResponse(path);
    }
    return { id: body.id as number, login: body.login };
  };
}

/** Read a PR's mergeability via `GET /repos/{owner}/{repo}/pulls/{number}` (read-only). */
export function createPullRequestFetcher(
  auth: InstallationAuth,
  installationId: string,
  options: GithubRequestOptions = {},
): PullRequestFetcher {
  return async (repoFullName: string, number: number) => {
    const repoPath = repoFullName.split("/").map(encodeURIComponent).join("/");
    const path = `/repos/${repoPath}/pulls/${number}`;
    const body = await githubGetJson<{
      mergeable?: unknown;
      mergeable_state?: unknown;
      draft?: unknown;
    }>(auth, installationId, path, options);
    if (body === undefined) return undefined;
    return {
      mergeable: typeof body.mergeable === "boolean" ? body.mergeable : null,
      mergeableState: typeof body.mergeable_state === "string" ? body.mergeable_state : "unknown",
      draft: body.draft === true,
    };
  };
}

/** Count of a PR's current distinct approvals, from the reviews list. */
export type ReviewApprovalFetcher = (
  repoFullName: string,
  number: number,
) => Promise<number | undefined>;

/**
 * Count current approvals via `GET /repos/{owner}/{repo}/pulls/{number}/reviews`
 * (read-only). Reviews are returned chronologically, so the last decision per
 * reviewer wins; COMMENTED/PENDING reviews don't change a reviewer's decision.
 * Used to suppress review reminders once a PR already has enough approvals.
 */
export function createReviewApprovalFetcher(
  auth: InstallationAuth,
  installationId: string,
  options: GithubRequestOptions = {},
): ReviewApprovalFetcher {
  return async (repoFullName: string, number: number) => {
    const repoPath = repoFullName.split("/").map(encodeURIComponent).join("/");
    const latestByUser = new Map<number, string>();
    for (let page = 1; ; page++) {
      const path = `/repos/${repoPath}/pulls/${number}/reviews?per_page=100&page=${page}`;
      const body = await githubGetJson<unknown>(auth, installationId, path, options);
      if (body === undefined) return undefined;
      if (!Array.isArray(body)) throw invalidResponse(path);
      for (const review of body) {
        if (typeof review !== "object" || review === null) continue;
        const userId = (review as { user?: { id?: unknown } }).user?.id;
        const state = (review as { state?: unknown }).state;
        if (!Number.isInteger(userId) || typeof state !== "string") continue;
        if (state === "COMMENTED" || state === "PENDING") continue; // not a decision
        latestByUser.set(userId as number, state);
      }
      if (body.length < 100) break; // last page
    }
    let approvals = 0;
    for (const state of latestByUser.values()) if (state === "APPROVED") approvals += 1;
    return approvals;
  };
}

/** Read whether the commit's CI is passing, failing, still running, or not configured. */
export type CiReadinessFetcher = (repoFullName: string, sha: string) => Promise<CiReadiness>;

interface CheckRunList {
  total_count?: unknown;
  check_runs?: unknown;
}

interface CheckSuiteList {
  total_count?: unknown;
  check_suites?: unknown;
}

interface CombinedStatus {
  state?: unknown;
  total_count?: unknown;
}

function repoPath(repoFullName: string): string {
  return repoFullName.split("/").map(encodeURIComponent).join("/");
}

const PAGE_LIMIT = 10;

/**
 * Page a GitHub list endpoint. Stops after {@link PAGE_LIMIT} pages; the caller
 * treats a truncated list as still pending so a missing later failure cannot
 * look like a green commit.
 */
async function listAll<T>(
  load: (page: number) => Promise<{ total: number; items: T[] }>,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let total = 0;
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    const body = await load(page);
    total = body.total;
    items.push(...body.items);
    if (items.length >= total || body.items.length === 0) return { items, truncated: false };
  }
  return { items, truncated: items.length < total };
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Production CI aggregate (read-only). Check runs and check suites use the
 * Checks permission. Legacy commit statuses use Commit statuses: Read. A 403
 * on that endpoint means the App has not been granted it; status-only CI is
 * then ignored and a warning is logged, while GitHub Actions checks still gate
 * alerts. Enable the permission and the Status webhook to cover both.
 */
export function createCiReadinessFetcher(
  auth: InstallationAuth,
  installationId: string,
  options: GithubRequestOptions & { logger?: Logger } = {},
): CiReadinessFetcher {
  return async (repoFullName: string, sha: string): Promise<CiReadiness> => {
    const root = `/repos/${repoPath(repoFullName)}/commits/${encodeURIComponent(sha)}`;

    const runs = await listAll<CiCheckRun>(async (page) => {
      const path = `${root}/check-runs?per_page=100&page=${page}`;
      const body = await githubGetJson<CheckRunList>(auth, installationId, path, options);
      if (body === undefined || !Array.isArray(body.check_runs)) throw invalidResponse(path);
      return {
        total: numberField(body.total_count),
        items: body.check_runs.map((entry) => {
          const run = typeof entry === "object" && entry !== null ? entry : {};
          const record = run as {
            name?: unknown;
            status?: unknown;
            conclusion?: unknown;
            started_at?: unknown;
            completed_at?: unknown;
          };
          return {
            name: stringField(record.name),
            status: stringField(record.status) ?? "",
            conclusion: stringField(record.conclusion),
            startedAt: stringField(record.started_at),
            completedAt: stringField(record.completed_at),
          };
        }),
      };
    });

    const suites = await listAll<CiCheckSuite>(async (page) => {
      const path = `${root}/check-suites?per_page=100&page=${page}`;
      const body = await githubGetJson<CheckSuiteList>(auth, installationId, path, options);
      if (body === undefined || !Array.isArray(body.check_suites)) throw invalidResponse(path);
      return {
        total: numberField(body.total_count),
        items: body.check_suites.map((entry) => {
          const suite = typeof entry === "object" && entry !== null ? entry : {};
          return { status: stringField((suite as { status?: unknown }).status) ?? "" };
        }),
      };
    });

    let commitStatus: CiCommitStatus = { state: null, count: 0 };
    const statusPath = `${root}/status`;
    try {
      const body = await githubGetJson<CombinedStatus>(auth, installationId, statusPath, options);
      if (body !== undefined) {
        commitStatus = {
          state: stringField(body.state),
          count: numberField(body.total_count),
        };
      }
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 403) {
        options.logger?.warn(
          "commit status API returned 403; grant the GitHub App Commit statuses: Read to gate status-only CI",
          { repoFullName },
        );
      } else {
        throw err;
      }
    }

    if (runs.truncated || suites.truncated) return "pending";
    return classifyCiReadiness({
      checkRuns: runs.items,
      checkSuites: suites.items,
      commitStatus,
    });
  };
}

/** Production fallback PR resolver (U7): the PR a commit heads, via the Checks-safe read API. */
export function createPrForShaFetcher(
  auth: InstallationAuth,
  installationId: string,
  options: GithubRequestOptions = {},
): PrForShaFetcher {
  return async (repoFullName: string, sha: string) => {
    const repoPath = repoFullName.split("/").map(encodeURIComponent).join("/");
    const path = `/repos/${repoPath}/commits/${encodeURIComponent(sha)}/pulls`;
    const body = await githubGetJson<unknown>(auth, installationId, path, options);
    if (body === undefined) return [];
    if (!Array.isArray(body)) throw invalidResponse(path);

    const numbers: number[] = [];
    for (const pullRequest of body) {
      if (
        typeof pullRequest !== "object" ||
        pullRequest === null ||
        !Number.isInteger((pullRequest as { number?: unknown }).number)
      ) {
        throw invalidResponse(path);
      }
      numbers.push((pullRequest as { number: number }).number);
    }
    return numbers;
  };
}
