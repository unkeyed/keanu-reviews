const DEAD_TOKEN_CODES: ReadonlySet<string> = new Set([
  "token_revoked",
  "invalid_auth",
  "account_inactive",
  "not_authed",
  "token_expired",
]);

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);

export class SlackApiError extends Error {
  readonly method: string;
  readonly code: string;
  readonly neededScope?: string;
  readonly providedScopes?: string;
  readonly retryAfterMs?: number;
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

  get ambiguous(): boolean {
    return this.code === "no_response" || this.code === "invalid_response";
  }

  get transient(): boolean {
    return this.ambiguous || TRANSIENT_CODES.has(this.code);
  }

  get deadToken(): boolean {
    return DEAD_TOKEN_CODES.has(this.code);
  }
}
