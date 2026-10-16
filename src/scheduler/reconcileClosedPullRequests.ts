import {
  findById,
  listOpenPullRequestsForReconciliation,
} from "../db/repositories/pullRequests.ts";
import type { PullRequestRow } from "../db/schema.ts";
import { isTerminal } from "../domain/prState.ts";
import {
  GithubRateLimitExhaustedError,
  type PullRequestSnapshot,
  type PullRequestSnapshotFetcher,
} from "../github/pullRequestSnapshot.ts";
import {
  type PrHandlerDeps,
  PullRequestLifecycleBusyError,
  type PullRequestPayload,
  handlePullRequest,
} from "../handlers/pullRequest.ts";
import type { Logger } from "../logger.ts";

export interface ReconciliationSummary {
  /** Pull requests whose GitHub state was read, or whose read failed. */
  checked: number;
  /** GitHub says merged, and the merge path archived the channel. */
  merged: number;
  /** GitHub says closed without merge, and the close path archived the channel. */
  closed: number;
  /** Channels archived by this run, including Slack `already_archived`. */
  archived: number;
  /** Still open, missing, stale, busy, or already closed in the database. */
  skipped: number;
  /** One PR failed; the run continued with the rest. */
  failed: number;
  /** Stopped before the remaining open PRs because the GitHub rate limit ran out. */
  rateLimited: boolean;
  /** Another run was already in progress in this process. */
  overlapped: boolean;
}

export interface ClosedPullRequestReconciliationDeps {
  /** Same dependencies the webhook worker uses for pull_request events. */
  handler: PrHandlerDeps;
  fetchSnapshot: PullRequestSnapshotFetcher;
  logger: Logger;
}

const ZERO: ReconciliationSummary = {
  checked: 0,
  merged: 0,
  closed: 0,
  archived: 0,
  skipped: 0,
  failed: 0,
  rateLimited: false,
  overlapped: false,
};

function summary(overrides: Partial<ReconciliationSummary> = {}): ReconciliationSummary {
  return { ...ZERO, ...overrides };
}

function channelArchived(row: PullRequestRow): boolean {
  return row.appliedState !== null && isTerminal(row.appliedState);
}

function outcomeOf(snapshot: PullRequestSnapshot): "merged" | "closed" | undefined {
  if (snapshot.merged) return "merged";
  if (snapshot.state === "closed") return "closed";
  return undefined;
}

function closedPayload(row: PullRequestRow, snapshot: PullRequestSnapshot): PullRequestPayload {
  return {
    action: "closed",
    repository: { full_name: row.repoFullName },
    pull_request: {
      number: snapshot.number,
      id: snapshot.id,
      draft: snapshot.draft,
      merged: snapshot.merged,
      title: snapshot.title,
      html_url: snapshot.htmlUrl,
      user: snapshot.user,
      head: { sha: snapshot.headSha, ref: snapshot.headRef },
      base: snapshot.baseRef ? { ref: snapshot.baseRef } : undefined,
      updated_at: snapshot.updatedAt,
    },
  };
}

/**
 * Catch merges and closes whose webhooks never arrived. For each PR the app
 * still treats as open, read GitHub. When GitHub says merged or closed, run the
 * webhook handler (`handlePullRequest`) so the channel is archived the same way.
 * One PR at a time. One failure is logged and the run continues. A second call
 * while this one is in progress returns without doing work; per-PR lifecycle
 * leases cover a second process.
 */
export function createClosedPullRequestReconciliation(
  deps: ClosedPullRequestReconciliationDeps,
): () => Promise<ReconciliationSummary> {
  let inProgress = false;

  return async function runClosedPullRequestReconciliation() {
    if (inProgress) {
      const overlapped = summary({ overlapped: true });
      deps.logger.info("pull request reconciliation skipped; another run is in progress", {
        ...overlapped,
      });
      return overlapped;
    }

    inProgress = true;
    try {
      return await reconcile(deps);
    } finally {
      inProgress = false;
    }
  };
}

async function reconcile(
  deps: ClosedPullRequestReconciliationDeps,
): Promise<ReconciliationSummary> {
  const { logger } = deps;
  const rows = await listOpenPullRequestsForReconciliation(deps.handler.db);
  const result = summary();

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row) continue;
    const fields = {
      repoFullName: row.repoFullName,
      number: row.number,
      githubPrId: row.githubPrId,
    };

    let fetched: Awaited<ReturnType<PullRequestSnapshotFetcher>>;
    try {
      fetched = await deps.fetchSnapshot(row.repoFullName, row.number);
    } catch (error) {
      if (error instanceof GithubRateLimitExhaustedError) {
        result.rateLimited = true;
        logger.warn("pull request reconciliation stopped; GitHub rate limit exhausted", {
          ...fields,
          deferred: rows.length - index,
          retryAfterMs: error.retryAfterMs,
          err: error.message,
        });
        break;
      }
      result.checked += 1;
      result.failed += 1;
      logger.error("pull request reconciliation failed", {
        ...fields,
        err: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    result.checked += 1;
    try {
      await applySnapshot(deps, row, fetched, result);
      if (fetched.remaining === 0) {
        result.rateLimited = true;
        logger.warn("pull request reconciliation stopped; GitHub rate limit exhausted", {
          ...fields,
          deferred: rows.length - index - 1,
          remaining: fetched.remaining,
        });
        break;
      }
    } catch (error) {
      if (error instanceof PullRequestLifecycleBusyError) {
        result.skipped += 1;
        logger.info("pull request reconciliation skipped; lifecycle already in progress", fields);
        continue;
      }
      result.failed += 1;
      logger.error("pull request reconciliation failed", {
        ...fields,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info("pull request reconciliation finished", { ...result });
  return result;
}

/** Apply one GitHub snapshot. Rate-limit exhaustion is decided by the caller. */
async function applySnapshot(
  deps: ClosedPullRequestReconciliationDeps,
  row: PullRequestRow,
  fetched: Awaited<ReturnType<PullRequestSnapshotFetcher>>,
  result: ReconciliationSummary,
): Promise<void> {
  const { logger } = deps;
  const fields = {
    repoFullName: row.repoFullName,
    number: row.number,
    githubPrId: row.githubPrId,
  };
  const snapshot = fetched.snapshot;

  if (!snapshot) {
    result.skipped += 1;
    logger.info("pull request reconciliation skipped; GitHub PR not found", fields);
    return;
  }

  const outcome = outcomeOf(snapshot);
  if (!outcome) {
    result.skipped += 1;
    logger.debug("pull request reconciliation skipped; pull request still open", fields);
    return;
  }

  if (snapshot.id !== row.githubPrId || snapshot.number !== row.number) {
    result.failed += 1;
    logger.error("pull request reconciliation failed; GitHub identity did not match", {
      ...fields,
      snapshotId: snapshot.id,
      snapshotNumber: snapshot.number,
    });
    return;
  }

  const fresh = await findById(deps.handler.db, row.id);
  if (!fresh || channelArchived(fresh) || isTerminal(fresh.currentState)) {
    result.skipped += 1;
    logger.info("pull request reconciliation skipped; already closed or archived", {
      ...fields,
      currentState: fresh?.currentState,
      appliedState: fresh?.appliedState,
    });
    return;
  }

  // `~` sorts after the webhook arrival keys (`${createdAt}:${jobId}`), so a
  // snapshot with the same updated_at is still accepted. A newer stored
  // snapshot is left alone (sourceAccepted false).
  const handled = await handlePullRequest(deps.handler, closedPayload(fresh, snapshot), {
    sourceArrivalKey: `~reconcile:${new Date().toISOString()}`,
  });
  if (!handled.sourceAccepted) {
    result.skipped += 1;
    logger.info("pull request reconciliation skipped; GitHub snapshot was stale", fields);
    return;
  }

  const after = await findById(deps.handler.db, row.id);
  if (!after || !channelArchived(after)) {
    result.failed += 1;
    logger.error("pull request reconciliation failed; channel was not archived", {
      ...fields,
      appliedState: after?.appliedState,
    });
    return;
  }

  if (outcome === "merged") result.merged += 1;
  else result.closed += 1;
  result.archived += 1;
  logger.info("pull request reconciliation archived channel", {
    ...fields,
    outcome,
    channelId: after.channelId,
    appliedState: after.appliedState,
  });
}
