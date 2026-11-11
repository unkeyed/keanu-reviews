import type { Db, JobRow } from "#db";
import { jobPrKeys } from "#events";
import { type Logger, type Loop, Permanent, RateLimited, Retry, errMessage, every } from "#lib";
import {
  LEASE_MS,
  claimNextJob,
  completeJob,
  failJob,
  releaseJob,
  renewJobLease,
  rescheduleJob,
} from "./store.ts";

// 2s doubling over 8 attempts spans about 4 minutes, which outlasts a crashed
// holder's message-effect lease after a redeploy.
export const MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 2_000;
// Lease errors can ask for the full 5-minute PR lifecycle lease. Nothing waits longer.
const MAX_RETRY_DELAY_MS = 5 * 60_000;
// GitHub's hourly quota can reset most of an hour out; retry at the reset, but
// check back at least every 15 minutes.
const MAX_RATE_LIMIT_DELAY_MS = 15 * 60_000;
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

/** A claimed job. `settled` resolves once it is settled, handed back, or lost. */
export interface Claimed {
  settled: Promise<void>;
}

export interface Worker {
  /**
   * Claim the next due job and start it once every earlier job claimed here
   * for the same PR has finished. A job still waiting when `draining` aborts
   * is handed back without running. Undefined when nothing is due.
   */
  claim(draining?: AbortSignal): Promise<Claimed | undefined>;
  /** Claim one job and wait for it to settle. False when nothing is due. */
  tick(): Promise<boolean>;
}

type Outcome =
  | { kind: "ran"; claim: JobRow; ok: true }
  | { kind: "ran"; claim: JobRow; ok: false; error: unknown }
  | { kind: "lost" }
  | { kind: "released" };

const NEVER = new AbortController().signal;

/**
 * Settle claimed jobs (KTD10). Success purges the raw payload (KTD13);
 * failures retry with exponential backoff before becoming terminal.
 */
export function createWorker(db: Db, logger: Logger, dispatch: Dispatch): Worker {
  // Per PR, the last job claimed in this process; the next one starts after it.
  const tails = new Map<string, Promise<void>>();

  /**
   * Hold the lease from the claim on, renewing it while the job waits its
   * turn and while its handler runs; each renewal moves the claim fence. The
   * handler timeout starts with the handler. Losing the lease or running past
   * the timeout aborts the handler's signal and stops waiting for it.
   */
  const runLeased = async (
    job: JobRow,
    turn: Promise<void>,
    draining: AbortSignal,
  ): Promise<Outcome> => {
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
    const stopLease = async () => {
      clearInterval(renewal);
      await renewing;
    };

    await untilAborted(turn, AbortSignal.any([controller.signal, draining])).catch(() => {});
    if (lost) {
      await stopLease();
      return { kind: "lost" };
    }
    if (draining.aborted) {
      await stopLease();
      await releaseJob(db, claim);
      return { kind: "released" };
    }

    const timeout = setTimeout(() => {
      controller.abort(new Error(`job handler timed out after ${HANDLER_TIMEOUT_MS}ms`));
    }, HANDLER_TIMEOUT_MS);
    timeout.unref?.();
    let result: { ok: true } | { ok: false; error: unknown };
    try {
      await untilAborted(dispatch(job, controller.signal), controller.signal);
      result = { ok: true };
    } catch (error) {
      result = { ok: false, error };
    }
    clearTimeout(timeout);
    await stopLease();
    return lost ? { kind: "lost" } : { kind: "ran", claim, ...result };
  };

  const settle = async (job: JobRow, turn: Promise<void>, draining: AbortSignal) => {
    // A crashed worker may have consumed the final attempt before its lease
    // expired. Reclaim the row for cleanup, but never execute the handler again.
    if (job.attempts > MAX_ATTEMPTS) {
      await failJob(db, job);
      return;
    }
    const outcome = await runLeased(job, turn, draining);
    // Lost: another worker owns the job now; its settlement is not ours to write.
    if (outcome.kind !== "ran") return;
    const { claim } = outcome;
    if (outcome.ok) {
      if (!(await completeJob(db, claim))) {
        logger.warn("job lease lost to another worker", { jobId: job.id, event: job.event });
      }
      return;
    }
    const { error } = outcome;
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
      return;
    }
    const willRetry = job.attempts < MAX_ATTEMPTS;
    const backoffMs = RETRY_BASE_MS * 2 ** Math.max(0, job.attempts - 1);
    const retryAfterMs = error instanceof Retry ? (error.retryAfterMs ?? 0) : 0;
    const maxDelayMs = error instanceof RateLimited ? MAX_RATE_LIMIT_DELAY_MS : MAX_RETRY_DELAY_MS;
    const retryDelay = Math.min(maxDelayMs, Math.max(backoffMs, retryAfterMs));
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
  };

  const claim = async (draining = NEVER): Promise<Claimed | undefined> => {
    const job = await claimNextJob(db);
    if (!job) return undefined;
    // Chain behind this PR's previous job before anything awaits, so jobs
    // for one PR start in claim order.
    const keys = jobPrKeys(job.event, job.raw);
    const turn = Promise.all(keys.map((key) => tails.get(key))).then(() => undefined);
    const settled = settle(job, turn, draining);
    const tail = Promise.all([turn, settled.catch(() => undefined)]).then(() => undefined);
    for (const key of keys) tails.set(key, tail);
    void tail.then(() => {
      for (const key of keys) if (tails.get(key) === tail) tails.delete(key);
    });
    return { settled };
  };

  return {
    claim,
    tick: async () => {
      const claimed = await claim();
      if (!claimed) return false;
      await claimed.settled;
      return true;
    },
  };
}

/**
 * Claim jobs whenever woken, and poll while idle: every second after work,
 * backing off to every five seconds, so a retry comes due at most five
 * seconds late. Up to `concurrency` claimed jobs are in flight at once; jobs
 * for the same PR wait for each other in claim order and count against it
 * while they wait. `stop` claims no further jobs, hands back the ones still
 * waiting their turn, and resolves once the running ones settle.
 */
export function startWorker(worker: Pick<Worker, "claim">, logger: Logger, concurrency = 1): Loop {
  const draining = new AbortController();
  const inFlight = new Set<Promise<void>>();
  let idleMs = IDLE_MIN_MS;
  const loop = every({
    delayMs: () => idleMs,
    run: async (stopping) => {
      let worked = false;
      while (!stopping.aborted) {
        if (inFlight.size >= concurrency) {
          await Promise.race(inFlight);
          continue;
        }
        const claimed = await worker.claim(draining.signal);
        if (!claimed) break;
        worked = true;
        const settled: Promise<void> = claimed.settled
          .catch((err) => logger.error("worker drain failed", { err: errMessage(err) }))
          .finally(() => inFlight.delete(settled));
        inFlight.add(settled);
      }
      idleMs = worked ? IDLE_MIN_MS : Math.min(IDLE_MAX_MS, idleMs * 2);
    },
    logger,
    failure: "worker drain failed",
  });
  return {
    wake: loop.wake,
    stop: async () => {
      draining.abort();
      await loop.stop();
      await Promise.all(inFlight);
    },
  };
}

/** The work's outcome, or the abort reason as soon as the signal fires. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
