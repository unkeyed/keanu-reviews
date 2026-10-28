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

export interface ChecksDeps extends ReviewRequestDeps {
  /** Fallback PR resolution for a head_sha not stored locally (e.g. fork checks). */
  fetchPrForSha?: PrForShaFetcher;
}

/**
 * A completed check run re-reads check runs for the PR head. The alert fires
 * only when that list is passing and the PR is not a draft. In-progress runs
 * are ignored; their completion event is the trigger.
 */
export async function handleCheckRun(
  deps: ChecksDeps,
  payload: CheckRunPayload,
  gate: ReviewAlertGate = {},
): Promise<void> {
  const run = payload.check_run;
  if (run.status !== "completed") return;

  const repoFullName = payload.repository.full_name;
  const headSha = run.head_sha;
  const associatedNumbers = new Set(run.pull_requests?.map((pr) => pr.number) ?? []);
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
      { sha: headSha, associations: [...associatedNumbers] },
    );
  }
  if (retry) throw retry;
}
