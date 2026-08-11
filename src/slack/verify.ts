import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Slack request signature (U9, security-critical — inbound public
 * endpoint). Computes `v0=HMAC-SHA256(signing_secret, "v0:{ts}:{body}")` over the
 * raw body and compares in constant time. Rejects stale timestamps (replay guard).
 */
export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string | undefined | null;
  rawBody: string;
  signature: string | undefined | null;
  now?: () => number;
}): boolean {
  const { signingSecret, timestamp, rawBody, signature } = input;
  if (!timestamp || !signature || !signature.startsWith("v0=")) return false;

  const now = (input.now ?? Date.now)();
  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds)) return false;
  if (Math.abs(now / 1000 - tsSeconds) > 300) return false; // >5 min old -> replay

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base, "utf8").digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
