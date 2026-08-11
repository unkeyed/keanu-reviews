import type { Logger } from "../logger.ts";

/**
 * In-process reminder timer (U8). Scans due reminders on an interval. Because it
 * runs inside the long-running service and claims each row atomically (KTD10), a
 * process restart just resumes scanning DB-backed rows — no reminder is lost.
 */
export function startReminderLoop(
  processDue: () => Promise<number>,
  intervalMs: number,
  logger: Logger,
): { stop: () => void } {
  let running = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    processDue()
      .catch((err) => {
        logger.error("reminder scan failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
