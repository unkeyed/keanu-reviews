/**
 * Signals an expected, transient condition rather than a failure — most often an
 * out-of-order delivery where a child event (check_run, review comment, review)
 * is processed before the PR's `pull_request.opened` event has created the Slack
 * channel. GitHub delivery is at-least-once and unordered (KTD4), so this race is
 * normal on nearly every PR that has CI.
 *
 * The worker retries these with backoff exactly like any thrown error, but logs
 * them quietly (info while retrying) instead of at `error`, so a routine race
 * does not read as an incident. Slack delivery is deduped, so the eventual
 * successful attempt does not double-post.
 *
 * `retryAfterMs` is the earliest point a retry can succeed, such as a Slack
 * Retry-After or the time left on a lease a crashed holder left. The worker
 * waits at least that long instead of spending attempts against it.
 */
export class RetryableError extends Error {
  readonly details?: Record<string, unknown>;
  readonly retryAfterMs?: number;

  constructor(message: string, details?: Record<string, unknown>, retryAfterMs?: number) {
    super(message);
    this.name = "RetryableError";
    this.details = details;
    this.retryAfterMs = retryAfterMs;
  }
}

// Live holders release a claim within seconds, so backoff finds it free. A
// claim older than a job lease was most likely orphaned by a crash, and only
// its own lease expiry frees it.
const LIVE_HOLDER_MS = 60_000;

/** How long to wait for another holder's claim, or undefined to just back off. */
export function orphanedClaimWaitMs(
  claimedAt: Date | null | undefined,
  leaseMs: number,
  now: number,
): number | undefined {
  if (!claimedAt) return undefined;
  const heldMs = now - claimedAt.getTime();
  return heldMs < LIVE_HOLDER_MS ? undefined : Math.max(0, leaseMs - heldMs);
}
