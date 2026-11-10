import { Retry } from "#lib";
import { SlackApiError } from "./errors.ts";

export type SleepFn = (ms: number) => Promise<void>;
const realSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry bounded Slack 429s while honoring Retry-After. A wait too long to sleep
 * through, or one more 429 than allowed, becomes a Retry for the durable job,
 * so the process never holds a DB lease while doing no useful work.
 */
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

/** Serialize calls sharing a key, enforcing a minimum interval between them. */
export class Pacer {
  private chains = new Map<string, Promise<unknown>>();
  private lastAt = new Map<string, number>();
  private readonly minIntervalMs: number;
  private readonly sleep: SleepFn;
  private readonly now: () => number;

  constructor(minIntervalMs: number, sleep: SleepFn = realSleep, now: () => number = Date.now) {
    this.minIntervalMs = minIntervalMs;
    this.sleep = sleep;
    this.now = now;
  }

  private cleanupWhenIdle(key: string, tail: Promise<unknown>): void {
    if (this.chains.get(key) !== tail) return;
    this.chains.delete(key);

    const lastAt = this.lastAt.get(key);
    if (lastAt === undefined) return;
    const remainingMs = Math.max(0, lastAt + this.minIntervalMs - this.now());
    const timer = setTimeout(() => {
      if (!this.chains.has(key) && this.lastAt.get(key) === lastAt) {
        this.lastAt.delete(key);
      }
    }, remainingMs);
    timer.unref?.();
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve();
    const next = prior.then(async () => {
      const lastAt = this.lastAt.get(key);
      if (lastAt !== undefined) {
        const wait = this.minIntervalMs - (this.now() - lastAt);
        if (wait > 0) await this.sleep(wait);
      }
      this.lastAt.set(key, this.now());
      return fn();
    });
    const tail = next.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => this.cleanupWhenIdle(key, tail));
    return next;
  }
}
