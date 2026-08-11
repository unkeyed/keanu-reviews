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
 */
export class RetryableError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "RetryableError";
    this.details = details;
  }
}
