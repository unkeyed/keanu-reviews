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

/** Retry a call up to `maxRetries` times when Slack reports 429, honoring Retry-After. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; sleep?: SleepFn } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const sleep = opts.sleep ?? realSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimited(err) && attempt < maxRetries) {
        attempt += 1;
        await sleep(err.retryAfterSeconds * 1000);
        continue;
      }
      throw err;
    }
  }
}

/** Serialize calls sharing a key, enforcing a minimum interval between them. */
export class Pacer {
  private chains = new Map<string, Promise<unknown>>();
  constructor(
    private readonly minIntervalMs: number,
    private readonly sleep: SleepFn = realSleep,
    private readonly now: () => number = Date.now,
  ) {}

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve();
    let lastAt = 0;
    const next = prior.then(async () => {
      const wait = this.minIntervalMs - (this.now() - lastAt);
      if (wait > 0) await this.sleep(wait);
      lastAt = this.now();
      return fn();
    });
    this.chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}
