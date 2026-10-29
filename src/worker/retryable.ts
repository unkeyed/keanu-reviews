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
 * Retry-After or the time left on a lease another claim holds. The worker
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
