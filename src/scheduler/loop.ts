import type { Logger } from "../logger.ts";

/**
 * In-process reminder timer (U8). Scans due reminders on an interval. Because it
 * runs inside the long-running service and claims each row atomically (KTD10), a
 * process restart just resumes scanning DB-backed rows — no reminder is lost.
 * `stop` schedules no further scans and resolves once the running scan finishes.
 */
export function startReminderLoop(
  processDue: () => Promise<number>,
  intervalMs: number,
  logger: Logger,
): { stop: () => Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (inFlight || stopped) return;
    inFlight = processDue()
      .then(() => undefined)
      .catch((err) => {
        logger.error("reminder scan failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight = undefined;
      });
  }, intervalMs);
  timer.unref?.();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
