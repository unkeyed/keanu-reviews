import { isTerminal, reconcileArrivalKey } from "#events";
import type { PullRequestSnapshot, PullRequestSnapshotFetcher } from "#github";
import { RateLimited, errMessage } from "#lib";
import type { PrDeps } from "./converge.ts";
import { PullRequestLifecycleBusyError, session } from "./session.ts";
import {
  type PrRow,
  findById,
  listOpenPullRequestsForReconciliation,
  listRecentlyClosedPullRequests,
} from "./store.ts";

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
  /** Merges whose #shipped note was not posted because the close was caught late. */
  skippedShipped: number;
  /** Merges whose GitHub merge comment was not posted because the close was caught late. */
  skippedMergeComments: number;
  /** Stopped before the remaining open PRs because the GitHub rate limit ran out. */
  rateLimited: boolean;
  /** Another run was already in progress in this process. */
  overlapped: boolean;
  /** Terminal PRs whose channel had drifted open (late write) and was re-archived. */
  reArchived: number;
}

const RE_ARCHIVE_WINDOW_MS = 7 * 24 * 60 * 60_000;

const MAX_BACKOFF_MS = 120_000;
const MAX_RATE_LIMIT_RETRIES = 3;

const ZERO: ReconciliationSummary = {
  checked: 0,
  merged: 0,
  closed: 0,
  archived: 0,
  skipped: 0,
  failed: 0,
  skippedShipped: 0,
  skippedMergeComments: 0,
  rateLimited: false,
  overlapped: false,
  reArchived: 0,
};

function channelArchived(row: PrRow): boolean {
  return row.appliedState !== null && isTerminal(row.appliedState);
}

function outcomeOf(snapshot: PullRequestSnapshot): "merged" | "closed" | undefined {
  if (snapshot.merged) return "merged";
  if (snapshot.state === "closed") return "closed";
  return undefined;
}

export function createClosedPullRequestReconciliation(
  deps: PrDeps,
  fetchSnapshot: PullRequestSnapshotFetcher,
): () => Promise<ReconciliationSummary> {
  let inProgress = false;

  return async function runClosedPullRequestReconciliation() {
    if (inProgress) {
      const overlapped = { ...ZERO, overlapped: true };
      deps.logger.info("pull request reconciliation skipped; another run is in progress", {
        ...overlapped,
      });
      return overlapped;
    }

    inProgress = true;
    try {
      return await reconcile(deps, fetchSnapshot);
    } finally {
      inProgress = false;
    }
  };
}

async function reconcile(
  deps: PrDeps,
  fetchSnapshot: PullRequestSnapshotFetcher,
): Promise<ReconciliationSummary> {
  const { logger } = deps;
  const rows = await listOpenPullRequestsForReconciliation(deps.db);
  const result = { ...ZERO };

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
      fetched = await fetchWaitingOutShortLimits(deps, fetchSnapshot, row);
    } catch (error) {
      if (error instanceof RateLimited) {
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
        err: errMessage(error),
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
        err: errMessage(error),
      });
    }
  }

  await reArchiveDriftedChannels(deps, result);

  logger.info("pull request reconciliation finished", { ...result });
  return result;
}

async function fetchWaitingOutShortLimits(
  deps: PrDeps,
  fetchSnapshot: PullRequestSnapshotFetcher,
  row: PrRow,
): ReturnType<PullRequestSnapshotFetcher> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchSnapshot(row.repoFullName, row.number);
    } catch (error) {
      const waitMs = error instanceof RateLimited ? error.retryAfterMs : undefined;
      if (waitMs === undefined || waitMs > MAX_BACKOFF_MS || attempt > MAX_RATE_LIMIT_RETRIES) {
        throw error;
      }
      deps.logger.info("GitHub rate limit backoff", {
        repoFullName: row.repoFullName,
        number: row.number,
        waitMs,
        attempt,
      });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function reArchiveDriftedChannels(
  deps: PrDeps,
  result: ReconciliationSummary,
): Promise<void> {
  const { slack, logger } = deps;
  const since = new Date(Date.now() - RE_ARCHIVE_WINDOW_MS);
  const rows = await listRecentlyClosedPullRequests(deps.db, since);
  for (const row of rows) {
    const channelId = row.channelId;
    if (!channelId) continue;
    const fields = { repoFullName: row.repoFullName, number: row.number, channelId };
    try {
      await session(deps, { kind: "existing", githubPrId: row.githubPrId }, async () => {
        const archived = await slack.isArchived(channelId);
        if (archived !== false) return;
        if (deps.quietArchive) await deps.quietArchive(channelId);
        await slack.archive(channelId);
        result.reArchived += 1;
        logger.info("re-archived PR channel that drifted open after a late write", fields);
      });
    } catch (error) {
      if (error instanceof PullRequestLifecycleBusyError) {
        logger.info("re-archive sweep skipped; lifecycle already in progress", fields);
        continue;
      }
      result.failed += 1;
      logger.error("re-archive sweep failed for a channel", {
        ...fields,
        err: errMessage(error),
      });
    }
  }
}

async function applySnapshot(
  deps: PrDeps,
  row: PrRow,
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

  if (snapshot.githubPrId !== row.githubPrId || snapshot.number !== row.number) {
    result.failed += 1;
    logger.error("pull request reconciliation failed; GitHub identity did not match", {
      ...fields,
      snapshotId: snapshot.githubPrId,
      snapshotNumber: snapshot.number,
    });
    return;
  }

  const fresh = await findById(deps.db, row.id);
  if (!fresh || channelArchived(fresh) || isTerminal(fresh.currentState)) {
    result.skipped += 1;
    logger.info("pull request reconciliation skipped; already closed or archived", {
      ...fields,
      currentState: fresh?.currentState,
      appliedState: fresh?.appliedState,
    });
    return;
  }

  const cause = {
    kind: "reconcile",
    merged: snapshot.merged,
    arrivalKey: reconcileArrivalKey(new Date()),
  } as const;
  const handled = await session(
    deps,
    { kind: "snapshot", snapshot: { ...snapshot, repo: fresh.repoFullName }, cause },
    async (s) => s.converged,
  );
  if (!handled?.accepted) {
    result.skipped += 1;
    logger.info("pull request reconciliation skipped; GitHub snapshot was stale", fields);
    return;
  }

  const after = await findById(deps.db, row.id);
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
  if (handled.skippedShipped) result.skippedShipped += 1;
  if (handled.skippedMergeComment) result.skippedMergeComments += 1;
  logger.info("pull request reconciliation archived channel", {
    ...fields,
    outcome,
    channelId: after.channelId,
    appliedState: after.appliedState,
    skippedShipped: handled.skippedShipped,
    skippedMergeComment: handled.skippedMergeComment,
  });
}
