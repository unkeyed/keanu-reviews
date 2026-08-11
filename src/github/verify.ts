import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a GitHub webhook signature (U3, security-critical).
 *
 * Computes HMAC-SHA256 over the RAW request body and compares it, in constant
 * time, to the `X-Hub-Signature-256` header. The legacy SHA-1 `X-Hub-Signature`
 * header is intentionally ignored. The raw body must be the exact bytes GitHub
 * signed — never a re-serialized JSON object (Hono JSON parsing would corrupt it).
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | undefined | null,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch; guard first so a wrong-length
  // signature is a clean false, not an exception.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
