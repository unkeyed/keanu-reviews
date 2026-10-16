import type { Logger } from "../logger.ts";

/**
 * Hour (UTC) the closed-PR reconciliation runs. The process has no cron library
 * and no platform scheduler — the reminder scanner is a short in-process
 * interval — so the reconciliation uses this once-a-day timer instead.
 * 08:00 UTC is after the US night and before the European afternoon.
 */
export const DAILY_RECONCILE_HOUR_UTC = 8;

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
 * In-process daily timer. One run at a time: if the task is still going when the
 * next slot arrives, that slot is skipped and the in-flight task schedules the
 * following day when it finishes. A restart resumes at the next slot; nothing
 * about the schedule is stored.
 */
export function startDailyLoop(
  task: () => Promise<unknown>,
  hourUtc: number,
  logger: Logger,
  now: () => Date = () => new Date(),
): { stop: () => void } {
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    const delayMs = millisecondsUntilUtcHour(now(), hourUtc);
    timer = setTimeout(tick, delayMs);
    timer.unref?.();
  };

  const tick = () => {
    if (stopped) return;
    // Arm the following day before the task starts so a long run cannot stack
    // another one, and a hang still leaves a future slot on the timer.
    schedule();
    if (running) {
      logger.warn("daily task still running; skipping overlapping slot");
      return;
    }
    running = true;
    task()
      .catch((err) => {
        logger.error("daily task failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        running = false;
      });
  };

  schedule();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
