import { errMessage, every } from "#lib";
import { createClosedPullRequestReconciliation } from "#pr";
import { createWorker, pruneJobHistory, startWorker } from "#queue";
import { scanDue } from "#reviews";
import type { AppContext } from "./context.ts";
import { createDispatcher } from "./handlers.ts";

/**
 * Hour (UTC) the closed-PR reconciliation runs. The process has no cron library
 * and no platform scheduler, so the reconciliation keeps its own once-a-day
 * timer. 08:00 UTC is after the US night and before the European afternoon.
 */
export const DAILY_RECONCILE_HOUR_UTC = 8;
const JOB_RETENTION_MS = 14 * 24 * 60 * 60_000;

/**
 * Milliseconds until the next `hourUtc:00:00.000` UTC. An exact hit waits a full
 * day so a restart at that instant does not run twice.
 */
export function millisecondsUntilUtcHour(now: Date, hourUtc: number): number {
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) {
    throw new Error(`hourUtc must be an integer from 0 through 23, got ${hourUtc}`);
  }
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0),
  );
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * The service's three loops (single active writer, KTD10): the job worker,
 * the reminder scan, and the daily closed-PR reconcile with job pruning. Each
 * runs one at a time; a restart resumes from the database, and nothing about
 * the schedule is stored. `nudge` wakes the worker for a job this process
 * just stored; `stop` resolves once every loop's work in flight has finished.
 */
export function startBackground(ctx: AppContext): { nudge: () => void; stop: () => Promise<void> } {
  const { db, deps, logger } = ctx;
  const worker = startWorker(createWorker(db, logger, createDispatcher(deps)), logger);
  const reminders = every({
    delayMs: () => ctx.config.REMINDER_SCAN_INTERVAL_MS,
    run: () => scanDue(deps),
    logger,
    failure: "reminder scan failed",
  });

  const reconcile = createClosedPullRequestReconciliation(deps, ctx.fetchSnapshot);
  const prune = async () => {
    const pruned = await pruneJobHistory(db, new Date(Date.now() - JOB_RETENTION_MS));
    logger.info("pruned job history", pruned);
  };
  const isolated = (task: string, run: () => Promise<unknown>) =>
    run().catch((err) => {
      logger.error("daily task failed", { task, err: errMessage(err) });
    });
  const daily = every({
    delayMs: () => millisecondsUntilUtcHour(new Date(), DAILY_RECONCILE_HOUR_UTC),
    run: () =>
      Promise.all([
        isolated("reconcile closed pull requests", reconcile),
        isolated("prune job history", prune),
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
