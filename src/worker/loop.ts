import type { Db } from "../db/client.ts";
import { claimNextJob, completeJob, rescheduleOrFailJob } from "../db/repositories/jobs.ts";
import type { Logger } from "../logger.ts";
import type { Router } from "./router.ts";

export interface WorkerDeps {
  db: Db;
  logger: Logger;
  router: Router;
  now?: () => number;
  maxAttempts?: number;
  retryBaseMs?: number;
  leaseMs?: number;
}

/**
 * Async job worker (KTD3). Claims one leased job at a time (KTD10) and routes it;
 * on success the raw payload is purged (KTD13); failures are retried with
 * exponential backoff before becoming terminal. Returns true if a job was
 * processed, false when the queue is empty.
 */
export function createWorker(deps: WorkerDeps) {
  const now = deps.now ?? Date.now;
  const maxAttempts = deps.maxAttempts ?? 5;
  const retryBaseMs = deps.retryBaseMs ?? 1_000;
  const leaseMs = deps.leaseMs ?? 60_000;

  const tick = async (): Promise<boolean> => {
    const job = await claimNextJob(deps.db, { now: new Date(now()), leaseMs });
    if (!job) return false;
    // A crashed worker may have consumed the final attempt before its lease
    // expired. Reclaim the row for cleanup, but never execute the handler again.
    if (job.attempts > maxAttempts) {
      await rescheduleOrFailJob(deps.db, job, {
        maxAttempts,
        retryAt: new Date(now()),
      });
      return true;
    }
    try {
      await deps.router(job);
      await completeJob(deps.db, job);
    } catch (err) {
      deps.logger.error("job failed", {
        jobId: job.id,
        event: job.event,
        err: err instanceof Error ? err.message : String(err),
      });
      const retryDelay = retryBaseMs * 2 ** Math.max(0, job.attempts - 1);
      await rescheduleOrFailJob(deps.db, job, {
        maxAttempts,
        retryAt: new Date(now() + retryDelay),
      });
    }
    return true;
  };

  /** Drain the queue until empty (used by tests and the smoke path). */
  const drain = async (): Promise<number> => {
    let n = 0;
    while (await tick()) n += 1;
    return n;
  };

  return { tick, drain };
}

/** Continuously drain the job queue on an interval (production loop). */
export function startWorkerLoop(
  worker: { drain: () => Promise<number> },
  intervalMs: number,
  logger: Logger,
): { stop: () => void } {
  let draining = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (draining || stopped) return;
    draining = true;
    worker
      .drain()
      .catch((err) => {
        logger.error("worker drain failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        draining = false;
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
