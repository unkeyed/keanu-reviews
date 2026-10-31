import type { Db } from "../db/client.ts";
import {
  claimNextJob,
  completeJob,
  renewJobLease,
  rescheduleOrFailJob,
} from "../db/repositories/jobs.ts";
import type { JobRow } from "../db/schema.ts";
import type { Logger } from "../logger.ts";
import { RetryableError } from "./retryable.ts";
import type { Router } from "./router.ts";

// Lease errors can ask for the full 5-minute PR lifecycle lease. Nothing waits longer.
const MAX_RETRY_DELAY_MS = 5 * 60_000;

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
  // 2s doubling over 8 attempts spans about 4 minutes, which outlasts a
  // crashed holder's message-effect lease after a redeploy.
  const maxAttempts = deps.maxAttempts ?? 8;
  const retryBaseMs = deps.retryBaseMs ?? 2_000;
  const leaseMs = deps.leaseMs ?? 60_000;

  // A handler can outlive the lease while it sleeps through a Slack Retry-After
  // or a paced burst. Renewing keeps another process from re-running the job
  // mid-flight. Each renewal moves the claim fence, so the returned release
  // hands back the latest claim to complete or reschedule with.
  const holdLease = (job: JobRow): (() => Promise<JobRow>) => {
    let claim = job;
    let renewing = Promise.resolve();
    const timer = setInterval(() => {
      renewing = renewing
        .then(async () => {
          const renewed = await renewJobLease(deps.db, claim, new Date(now()));
          if (renewed) {
            claim = renewed;
            return;
          }
          clearInterval(timer);
          deps.logger.warn("job lease lost to another worker", {
            jobId: job.id,
            event: job.event,
          });
        })
        .catch((err) => {
          deps.logger.warn("job lease renewal failed", {
            jobId: job.id,
            err: err instanceof Error ? err.message : String(err),
          });
        });
    }, leaseMs / 3);
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      await renewing;
      return claim;
    };
  };

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
    const releaseLease = holdLease(job);
    try {
      await deps.router(job);
      await completeJob(deps.db, await releaseLease());
    } catch (err) {
      const claim = await releaseLease();
      const message = err instanceof Error ? err.message : String(err);
      const willRetry = job.attempts < maxAttempts;
      const backoffMs = retryBaseMs * 2 ** Math.max(0, job.attempts - 1);
      const retryAfterMs = err instanceof RetryableError ? (err.retryAfterMs ?? 0) : 0;
      const retryDelay = Math.min(MAX_RETRY_DELAY_MS, Math.max(backoffMs, retryAfterMs));
      if (err instanceof RetryableError) {
        // Expected transient condition (e.g. out-of-order delivery). Retry
        // quietly; only escalate to warn once it stops being transient.
        const fields = {
          jobId: job.id,
          event: job.event,
          attempt: job.attempts,
          retryInMs: retryDelay,
          ...err.details,
        };
        if (willRetry) {
          deps.logger.info("job deferred, will retry", { ...fields, reason: message });
        } else {
          deps.logger.warn("job gave up after retries", { ...fields, reason: message });
        }
      } else {
        deps.logger.error("job failed", { jobId: job.id, event: job.event, err: message });
      }
      await rescheduleOrFailJob(deps.db, claim, {
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

/**
 * Continuously drain the job queue on an interval (production loop). `stop`
 * claims no further jobs and resolves once the job already running finishes.
 */
export function startWorkerLoop(
  worker: { tick: () => Promise<boolean> },
  intervalMs: number,
  logger: Logger,
): { stop: () => Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const drainUntilStopped = async () => {
    while (!stopped && (await worker.tick())) {}
  };
  const timer = setInterval(() => {
    if (inFlight || stopped) return;
    inFlight = drainUntilStopped()
      .catch((err) => {
        logger.error("worker drain failed", {
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
