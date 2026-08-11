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
  const timer = setInterval(() => {
    processDue().catch((err) => {
      logger.error("reminder scan failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
