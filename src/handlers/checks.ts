import type { PrForShaFetcher } from "../ci/status.ts";
import { findAllByRepoHeadSha, findAllByRepoNumbers } from "../db/repositories/pullRequests.ts";
import { RetryableError } from "../worker/retryable.ts";
import { type MergeabilityDeps, reportMergeability } from "./mergeability.ts";

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

export interface ChecksDeps extends MergeabilityDeps {
  /** Fallback PR resolution for a head_sha not stored locally (e.g. fork checks). */
  fetchPrForSha?: PrForShaFetcher;
}

/**
 * CI completion is the trigger to refresh PR mergeability (R6, replaces the
 * former per-check messages). When a check finishes we resolve the associated
 * PR(s) by head_sha and report their overall `mergeable_state` — conflicts,
 * branch protection, and required checks folded into one signal — posting only
 * when it changed (see `reportMergeability`).
 */
export async function handleCheckRun(deps: ChecksDeps, payload: CheckRunPayload): Promise<void> {
  const run = payload.check_run;
  if (payload.action !== "completed" || run.status !== "completed") return;

  const repoFullName = payload.repository.full_name;
  const associatedNumbers = new Set(run.pull_requests?.map((pr) => pr.number) ?? []);
  let rows =
    associatedNumbers.size > 0
      ? await findAllByRepoNumbers(deps.db, repoFullName, [...associatedNumbers])
      : await findAllByRepoHeadSha(deps.db, repoFullName, run.head_sha);

  if (rows.length === 0 && associatedNumbers.size === 0 && deps.fetchPrForSha) {
    for (const number of await deps.fetchPrForSha(repoFullName, run.head_sha)) {
      associatedNumbers.add(number);
    }
    rows = await findAllByRepoNumbers(deps.db, repoFullName, [...associatedNumbers]);
  }

  const hasMissingAssociations = associatedNumbers.size > rows.length;
  if (rows.length === 0) {
    if (hasMissingAssociations) {
      throw new RetryableError(
        `PR channel is not ready for every check_run association in ${repoFullName}`,
        { sha: run.head_sha, associations: [...associatedNumbers] },
      );
    }
    deps.logger.debug("check_run maps to no tracked PR", { sha: run.head_sha });
    return;
  }

  for (const row of rows) {
    if (!row.channelId) continue;
    await reportMergeability(deps, row, `check-run:${run.id}`);
  }

  if (hasMissingAssociations || rows.some((row) => !row.channelId)) {
    throw new RetryableError(
      `PR channel is not ready for every check_run association in ${repoFullName}`,
      { sha: run.head_sha, associations: [...associatedNumbers] },
    );
  }
}
