import type { Db } from "#db";
import { type Logger, errMessage, every } from "#lib";
import {
  PULL_REQUEST_LIFECYCLE_LEASE_MS,
  createClosedPullRequestReconciliation,
  deleteLifecycleClaimsBefore,
} from "#pr";
import { createWorker, pruneJobHistory, startWorker } from "#queue";
import { scanDue } from "#reviews";
import type { AppContext } from "./context.ts";
import { createDispatcher } from "./handlers.ts";

const DAILY_RECONCILE_HOUR_UTC = 8;
const JOB_RETENTION_MS = 14 * 24 * 60 * 60_000;
const ORPHANED_CLAIM_MS = 288 * PULL_REQUEST_LIFECYCLE_LEASE_MS;

export function millisecondsUntilUtcHour(now: Date, hourUtc: number): number {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0),
  );
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export async function pruneHistory(db: Db, logger: Logger, now = new Date()): Promise<void> {
  const pruned = await pruneJobHistory(db, new Date(now.getTime() - JOB_RETENTION_MS));
  const lifecycleClaims = await deleteLifecycleClaimsBefore(
    db,
    new Date(now.getTime() - ORPHANED_CLAIM_MS),
  );
  logger.info("pruned job history", { ...pruned, lifecycleClaims });
}

export function startBackground(ctx: AppContext): { nudge: () => void; stop: () => Promise<void> } {
  const { db, deps, logger } = ctx;
  const worker = startWorker(
    createWorker(db, logger, createDispatcher(deps)),
    logger,
    ctx.config.WORKER_CONCURRENCY,
  );
  const reminders = every({
    delayMs: () => ctx.config.REMINDER_SCAN_INTERVAL_MS,
    run: () => scanDue(deps),
    logger,
    failure: "reminder scan failed",
  });

  const reconcile = createClosedPullRequestReconciliation(deps, deps.fetchSnapshot);
  const isolated = (task: string, run: () => Promise<unknown>) =>
    run().catch((err) => {
      logger.error("daily task failed", { task, err: errMessage(err) });
    });
  const daily = every({
    delayMs: () => millisecondsUntilUtcHour(new Date(), DAILY_RECONCILE_HOUR_UTC),
    run: () =>
      Promise.all([
        isolated("reconcile closed pull requests", reconcile),
        isolated("prune job history", () => pruneHistory(db, logger)),
      ]),
    logger,
    failure: "daily task failed",
    overlap: "daily task still running; skipping overlapping slot",
  });
  logger.info("closed pull request reconciliation scheduled", {
    hourUtc: DAILY_RECONCILE_HOUR_UTC,
  });

  return {
    nudge: worker.wake,
    stop: async () => {
      await Promise.all([worker.stop(), reminders.stop(), daily.stop()]);
    },
  };
}
