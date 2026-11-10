/**
 * The one "try again later" signal. GitHub delivery is at-least-once and
 * unordered, so a child event routinely arrives before the PR channel exists;
 * the worker retries these with backoff and logs them quietly instead of at
 * `error`. `retryAfterMs` is the earliest point a retry can succeed, such as a
 * Slack Retry-After or the time left on a lease a crashed holder left.
 */
export class Retry extends Error {
  readonly details?: Record<string, unknown>;
  readonly retryAfterMs?: number;

  constructor(message: string, details?: Record<string, unknown>, retryAfterMs?: number) {
    super(message);
    this.name = "Retry";
    this.details = details;
    this.retryAfterMs = retryAfterMs;
  }
}

// Live holders release a claim within seconds, so backoff finds it free. A
// claim older than a job lease was most likely orphaned by a crash, and only
// its own lease expiry frees it.
const LIVE_HOLDER_MS = 60_000;

/** How long to wait for another holder's claim, or undefined to just back off. */
export function leaseWaitMs(
  claimedAt: Date | null | undefined,
  leaseMs: number,
  now: Date,
): number | undefined {
  if (!claimedAt) return undefined;
  const heldMs = now.getTime() - claimedAt.getTime();
  return heldMs < LIVE_HOLDER_MS ? undefined : Math.max(0, leaseMs - heldMs);
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
