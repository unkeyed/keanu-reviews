const DEAD_TOKEN_CODES: ReadonlySet<string> = new Set([
  "token_revoked",
  "invalid_auth",
  "account_inactive",
  "not_authed",
  "token_expired",
]);

/** Slack-side failures a later attempt of the same call can get past. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);

/**
 * Every failure the Slack gateway throws. `code` is Slack's `error` string for
 * a platform error, `ratelimited` for a 429, `no_response` when the call failed
 * in transport, and `invalid_response` when Slack answered without a field we
 * need.
 */
export class SlackApiError extends Error {
  readonly method: string;
  readonly code: string;
  readonly neededScope?: string;
  readonly providedScopes?: string;
  readonly retryAfterMs?: number;
  /** The platform error body, e.g. per-user `errors` on conversations.invite. */
  readonly data?: unknown;

  constructor(
    method: string,
    code: string,
    opts: {
      message?: string;
      neededScope?: string;
      providedScopes?: string;
      retryAfterMs?: number;
      data?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(opts.message ?? `${method}: ${code}`, { cause: opts.cause });
    this.name = "SlackApiError";
    this.method = method;
    this.code = code;
    this.neededScope = opts.neededScope;
    this.providedScopes = opts.providedScopes;
    this.retryAfterMs = opts.retryAfterMs;
    this.data = opts.data;
  }

  /** No usable answer arrived, so the call may have taken effect in Slack. */
  get ambiguous(): boolean {
    return this.code === "no_response" || this.code === "invalid_response";
  }

  /** Retrying the same call later can succeed, or it may already have taken effect. */
  get transient(): boolean {
    return this.ambiguous || TRANSIENT_CODES.has(this.code);
  }

  /** A user token Slack will never accept again. */
  get deadToken(): boolean {
    return DEAD_TOKEN_CODES.has(this.code);
  }
}
