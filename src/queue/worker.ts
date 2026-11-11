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

export const MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 2_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const MAX_RATE_LIMIT_DELAY_MS = 15 * 60_000;
const RENEW_EVERY_MS = LEASE_MS / 3;

export const HANDLER_TIMEOUT_MS = 100_000;

const IDLE_MIN_MS = 1_000;
const IDLE_MAX_MS = 5_000;

export type Dispatch = (job: JobRow, signal: AbortSignal) => Promise<void>;

export interface Claimed {
  settled: Promise<void>;
}

export interface Worker {
  claim(draining?: AbortSignal): Promise<Claimed | undefined>;
}

type Outcome =
  | { kind: "ran"; claim: JobRow; ok: true }
  | { kind: "ran"; claim: JobRow; ok: false; error: unknown }
  | { kind: "lost" }
  | { kind: "released" };

const NEVER = new AbortController().signal;

export function createWorker(db: Db, logger: Logger, dispatch: Dispatch): Worker {
  const tails = new Map<string, Promise<void>>();

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
    if (job.attempts > MAX_ATTEMPTS) {
      await failJob(db, job);
      return;
    }
    const outcome = await runLeased(job, turn, draining);
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

  return { claim };
}

export function startWorker(worker: Worker, logger: Logger, concurrency = 1): Loop {
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

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
