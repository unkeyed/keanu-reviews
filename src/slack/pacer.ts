import { Retry } from "#lib";
import { SlackApiError } from "./errors.ts";

export type SleepFn = (ms: number) => Promise<void>;
const realSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; maxRetryDelayMs: number; sleep?: SleepFn },
): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof SlackApiError) || err.code !== "ratelimited") throw err;
      const retryAfterMs = err.retryAfterMs ?? 1000;
      if (attempt >= opts.maxRetries || retryAfterMs > opts.maxRetryDelayMs) {
        throw new Retry(
          `Slack rate limited; retry after ${retryAfterMs / 1000}s`,
          undefined,
          retryAfterMs,
        );
      }
      attempt += 1;
      await sleep(retryAfterMs);
    }
  }
}

export function createPacer(
  minIntervalMs: number,
  sleep: SleepFn = realSleep,
  now: () => number = Date.now,
) {
  const chains = new Map<string, Promise<unknown>>();
  const lastAt = new Map<string, number>();

  const cleanupWhenIdle = (key: string, tail: Promise<unknown>): void => {
    if (chains.get(key) !== tail) return;
    chains.delete(key);

    const last = lastAt.get(key);
    if (last === undefined) return;
    const remainingMs = Math.max(0, last + minIntervalMs - now());
    const timer = setTimeout(() => {
      if (!chains.has(key) && lastAt.get(key) === last) lastAt.delete(key);
    }, remainingMs);
    timer.unref?.();
  };

  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prior = chains.get(key) ?? Promise.resolve();
      const next = prior.then(async () => {
        const last = lastAt.get(key);
        if (last !== undefined) {
          const wait = minIntervalMs - (now() - last);
          if (wait > 0) await sleep(wait);
        }
        lastAt.set(key, now());
        return fn();
      });
      const tail = next.catch(() => undefined);
      chains.set(key, tail);
      void tail.then(() => cleanupWhenIdle(key, tail));
      return next;
    },
  };
}
