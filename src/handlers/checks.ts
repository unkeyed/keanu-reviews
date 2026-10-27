import type { PrForShaFetcher } from "../ci/status.ts";
import { findAllByRepoHeadSha, findAllByRepoNumbers } from "../db/repositories/pullRequests.ts";
import { RetryableError } from "../worker/retryable.ts";
import {
  type ReviewAlertGate,
  type ReviewRequestDeps,
  releaseReadyReviewAlerts,
} from "./reviewRequest.ts";

export interface CheckRunPayload {
  action: string;
  repository: { full_name: string };
  check_run: {
    id: number;
    status: string; // queued | in_progress | completed
    conclusion: string | null;
    html_url: string;
    head_sha: string;
    name: string;
    pull_requests?: { number: number }[];
  };
}

export interface CheckSuitePayload {
  action: string;
  repository: { full_name: string };
  check_suite: {
    id: number;
    status: string;
    conclusion: string | null;
    head_sha: string;
    pull_requests?: { number: number }[];
  };
}

export interface CommitStatusPayload {
  sha?: string;
  state?: string;
  repository?: { full_name?: string };
}

export interface ChecksDeps extends ReviewRequestDeps {
  /** Fallback PR resolution for a head_sha not stored locally (e.g. fork checks). */
  fetchPrForSha?: PrForShaFetcher;
}

/**
 * CI completion re-checks whether a held review alert may fire. One finished
 * check is not "CI passed" — the alert waits until the aggregate for the PR's
 * current head is passing. In-progress runs are ignored here; the completion
 * event (check_run, check_suite, or legacy status) is the trigger.
 */
export async function handleCheckRun(
  deps: ChecksDeps,
  payload: CheckRunPayload,
  gate: ReviewAlertGate = {},
): Promise<void> {
  const run = payload.check_run;
  if (run.status !== "completed") return;

  await reevaluateHead(
    deps,
    payload.repository.full_name,
    run.head_sha,
    numbersOf(run.pull_requests),
    gate,
  );
}

export async function handleCheckSuite(
  deps: ChecksDeps,
  payload: CheckSuitePayload,
  gate: ReviewAlertGate = {},
): Promise<void> {
  const suite = payload.check_suite;
  if (suite.status !== "completed") return;

  await reevaluateHead(
    deps,
    payload.repository.full_name,
    suite.head_sha,
    numbersOf(suite.pull_requests),
    gate,
  );
}

/** Legacy commit status (`status` webhook). Any state can be the failing → passing edge. */
export async function handleCommitStatus(
  deps: ChecksDeps,
  payload: CommitStatusPayload,
  gate: ReviewAlertGate = {},
): Promise<void> {
  const repoFullName = payload.repository?.full_name;
  const sha = payload.sha;
  if (!repoFullName || !sha) {
    deps.logger.debug("status event missing repository or sha");
    return;
  }
  await reevaluateHead(deps, repoFullName, sha, new Set(), gate);
}

function numbersOf(pullRequests: { number: number }[] | undefined): Set<number> {
  return new Set(pullRequests?.map((pr) => pr.number) ?? []);
}

async function reevaluateHead(
  deps: ChecksDeps,
  repoFullName: string,
  headSha: string,
  associatedNumbers: Set<number>,
  gate: ReviewAlertGate,
): Promise<void> {
  let rows =
    associatedNumbers.size > 0
      ? await findAllByRepoNumbers(deps.db, repoFullName, [...associatedNumbers])
      : await findAllByRepoHeadSha(deps.db, repoFullName, headSha);

  if (rows.length === 0 && associatedNumbers.size === 0 && deps.fetchPrForSha) {
    for (const number of await deps.fetchPrForSha(repoFullName, headSha)) {
      associatedNumbers.add(number);
    }
    rows = await findAllByRepoNumbers(deps.db, repoFullName, [...associatedNumbers]);
  }

  const hasMissingAssociations = associatedNumbers.size > rows.length;
  if (rows.length === 0) {
    if (hasMissingAssociations) {
      throw new RetryableError(
        `PR channel is not ready for every CI association in ${repoFullName}`,
        { sha: headSha, associations: [...associatedNumbers] },
      );
    }
    deps.logger.debug("CI event maps to no tracked PR", { sha: headSha });
    return;
  }

  let retry: RetryableError | undefined;
  for (const row of rows) {
    if (!row.channelId) continue;
    if (row.headSha && row.headSha !== headSha) {
      deps.logger.debug("ignoring CI event for a stale head", {
        prId: row.id,
        headSha: row.headSha,
        eventSha: headSha,
      });
      continue;
    }
    try {
      await releaseReadyReviewAlerts(deps, row, gate);
    } catch (err) {
      if (err instanceof RetryableError) {
        retry = err;
        continue;
      }
      throw err;
    }
  }

  if (hasMissingAssociations || rows.some((row) => !row.channelId)) {
    throw new RetryableError(
      `PR channel is not ready for every CI association in ${repoFullName}`,
      {
        sha: headSha,
        associations: [...associatedNumbers],
      },
    );
  }
  if (retry) throw retry;
}
