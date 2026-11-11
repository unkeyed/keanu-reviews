import type { Db, JobRow } from "#db";
import { type Logger, type Loop, Permanent, Retry, errMessage, every } from "#lib";
import {
  LEASE_MS,
  claimNextJob,
  completeJob,
  failJob,
  renewJobLease,
  rescheduleJob,
} from "./store.ts";

// 2s doubling over 8 attempts spans about 4 minutes, which outlasts a crashed
// holder's message-effect lease after a redeploy.
export const MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 2_000;
// Lease errors can ask for the full 5-minute PR lifecycle lease. Nothing waits longer.
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const RENEW_EVERY_MS = LEASE_MS / 3;

/**
 * A handler running this long is aborted and its job retried. It stays under
 * the 2-minute message-effect lease, so no Slack effect a live handler claimed
 * can be taken over by another worker, with one renewal period to spare for
 * the abort to land. Healthy handlers finish in seconds; the slowest, a close
 * that walks every member out of the channel, makes a few dozen Slack calls.
 */
export const HANDLER_TIMEOUT_MS = 100_000;

// The idle poll finds jobs another replica enqueued and retries that come due.
// A nudge from this process's webhook wakes the worker at once.
const IDLE_MIN_MS = 1_000;
const IDLE_MAX_MS = 5_000;

export type Dispatch = (job: JobRow, signal: AbortSignal) => Promise<void>;

/**
 * Settle one claimed job at a time (KTD10). Success purges the raw payload
 * (KTD13); failures retry with exponential backoff before becoming terminal.
 */
export function createWorker(db: Db, logger: Logger, dispatch: Dispatch) {
  /**
   * Run the handler under a renewed lease. A handler can outlive the lease
   * while it sleeps through a Slack Retry-After or a paced burst, and each
   * renewal moves the claim fence. Losing the lease or running past the
   * timeout aborts the handler's signal and stops waiting for it.
   */
  const runLeased = async (
    job: JobRow,
  ): Promise<{ claim: JobRow; lost: boolean; error?: unknown }> => {
    const controller = new AbortController();
    let claim = job;
    let lost = false;
    let renewing = Promise.resolve();
    const renewal = setInterval(() => {
      renewing = renewing
        .then(async () => {
          const renewed = await renewJobLease(db, claim, new Date());
          if (renewed) {
            claim = renewed;
            return;
          }
          clearInterval(renewal);
          lost = true;
          logger.warn("job lease lost to another worker", { jobId: job.id, event: job.event });
          controller.abort(new Error("job lease lost to another worker"));
        })
        .catch((err) => {
          logger.warn("job lease renewal failed", { jobId: job.id, err: errMessage(err) });
        });
    }, RENEW_EVERY_MS);
    renewal.unref?.();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`job handler timed out after ${HANDLER_TIMEOUT_MS}ms`));
    }, HANDLER_TIMEOUT_MS);
    timeout.unref?.();
    try {
      await untilAborted(dispatch(job, controller.signal), controller.signal);
      return { claim, lost };
    } catch (error) {
      return { claim, lost, error };
    } finally {
      clearInterval(renewal);
      clearTimeout(timeout);
      await renewing;
    }
  };

  /** Claim and settle one job. False when nothing is due. */
  const tick = async (): Promise<boolean> => {
    const job = await claimNextJob(db);
    if (!job) return false;
    // A crashed worker may have consumed the final attempt before its lease
    // expired. Reclaim the row for cleanup, but never execute the handler again.
    if (job.attempts > MAX_ATTEMPTS) {
      await failJob(db, job);
      return true;
    }
    const { claim, lost, error } = await runLeased(job);
    // Another worker owns the job now; its settlement is not ours to write.
    if (lost) return true;
    if (error === undefined) {
      if (!(await completeJob(db, claim))) {
        logger.warn("job lease lost to another worker", { jobId: job.id, event: job.event });
      }
      return true;
    }
    const message = errMessage(error);
    if (error instanceof Permanent) {
      logger.error("job failed permanently", {
        jobId: job.id,
        event: job.event,
        attempt: job.attempts,
        reason: message,
        ...error.details,
      });
      await failJob(db, claim);
      return true;
    }
    const willRetry = job.attempts < MAX_ATTEMPTS;
    const backoffMs = RETRY_BASE_MS * 2 ** Math.max(0, job.attempts - 1);
    const retryAfterMs = error instanceof Retry ? (error.retryAfterMs ?? 0) : 0;
    const retryDelay = Math.min(MAX_RETRY_DELAY_MS, Math.max(backoffMs, retryAfterMs));
    if (error instanceof Retry) {
      // Expected transient condition (e.g. out-of-order delivery). Retry
      // quietly; only escalate to warn once it stops being transient.
      const fields = {
        jobId: job.id,
        event: job.event,
        attempt: job.attempts,
        retryInMs: retryDelay,
        ...error.details,
      };
      if (willRetry) {
        logger.info("job deferred, will retry", { ...fields, reason: message });
      } else {
        logger.warn("job gave up after retries", { ...fields, reason: message });
      }
    } else {
      logger.error("job failed", { jobId: job.id, event: job.event, err: message });
    }
    if (willRetry) await rescheduleJob(db, claim, new Date(Date.now() + retryDelay));
    else await failJob(db, claim);
    return true;
  };

  return { tick };
}

/**
 * Drain the queue whenever woken, and poll while idle: every second after
 * work, backing off to every five seconds, so a retry comes due at most five
 * seconds late. `stop` claims no further jobs and resolves once the job
 * already running settles.
 */
export function startWorker(worker: { tick: () => Promise<boolean> }, logger: Logger): Loop {
  let idleMs = IDLE_MIN_MS;
  return every({
    delayMs: () => idleMs,
    run: async (stopping) => {
      let worked = false;
      while (!stopping.aborted && (await worker.tick())) worked = true;
      idleMs = worked ? IDLE_MIN_MS : Math.min(IDLE_MAX_MS, idleMs * 2);
    },
    logger,
    failure: "worker drain failed",
  });
}

/** The handler's outcome, or the abort reason as soon as the signal fires. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
