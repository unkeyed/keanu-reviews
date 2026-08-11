/**
 * Client-side rate limiting (KTD9). Two concerns:
 *  - honor Slack HTTP 429 `Retry-After` by waiting and retrying;
 *  - pace bursty methods (channel creation is Tier 2 ~20/min) via a serialized
 *    per-key minimum interval so a PR flood queues instead of being throttled.
 */
export interface RateLimitedError {
  status: 429;
  retryAfterSeconds: number;
}

const isRateLimited = (e: unknown): e is RateLimitedError =>
  typeof e === "object" && e !== null && (e as { status?: number }).status === 429;

export type SleepFn = (ms: number) => Promise<void>;
const realSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry bounded 429 responses while honoring Retry-After; defer long waits to the durable job. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; maxRetryDelayMs?: number; sleep?: SleepFn } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const maxRetryDelayMs = opts.maxRetryDelayMs ?? Number.POSITIVE_INFINITY;
  const sleep = opts.sleep ?? realSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimited(err) && attempt < maxRetries) {
        const retryDelayMs = err.retryAfterSeconds * 1000;
        // A very long Retry-After belongs at the durable job layer. Keeping it
        // here would hold a DB lease while the process is doing no useful work.
        if (retryDelayMs > maxRetryDelayMs) throw err;
        attempt += 1;
        await sleep(retryDelayMs);
        continue;
      }
      throw err;
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
