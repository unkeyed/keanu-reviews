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

export class RateLimited extends Retry {
  constructor(message: string, details?: Record<string, unknown>, retryAfterMs?: number) {
    super(message, details, retryAfterMs);
    this.name = "RateLimited";
  }
}

export class Permanent extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "Permanent";
    this.details = details;
  }
}

const LIVE_HOLDER_MS = 60_000;

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
