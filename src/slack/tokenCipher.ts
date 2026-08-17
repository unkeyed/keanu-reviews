import { createCipheriv, createDecipheriv, randomBytes as cryptoRandomBytes } from "node:crypto";

/**
 * Authenticated encryption for Slack user tokens at rest. Unlike the GitHub
 * OAuth flow — which only reads an identity and discards the token — the silent
 * archive feature must persist each participant's `xoxp-` token to call
 * `conversations.leave` on their behalf later. Those tokens are secrets, so we
 * never store them in plaintext.
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>` with each segment base64url. AES-256-GCM
 * gives confidentiality plus tamper detection (a modified ciphertext fails the
 * auth tag on decrypt rather than yielding garbage).
 */
const VERSION = "v1";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32; // AES-256

export interface TokenCipher {
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
}

/**
 * Accept the configured key as hex (64 chars), base64, or base64url and require
 * it to decode to exactly 32 bytes so a truncated/mistyped key fails at boot,
 * not on the first archive.
 */
function decodeKey(keyMaterial: string): Buffer {
  const trimmed = keyMaterial.trim();
  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) candidates.push(Buffer.from(trimmed, "hex"));
  candidates.push(Buffer.from(trimmed, "base64url"));
  candidates.push(Buffer.from(trimmed, "base64"));
  const key = candidates.find((buffer) => buffer.length === KEY_BYTES);
  if (!key) {
    throw new Error(
      "Slack token encryption key must decode to 32 bytes (hex, base64, or base64url)",
    );
  }
  return key;
}

export function createTokenCipher(
  keyMaterial: string,
  randomBytes: (size: number) => Buffer = cryptoRandomBytes,
): TokenCipher {
  const key = decodeKey(keyMaterial);

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        VERSION,
        iv.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },
    decrypt(payload) {
      const [version, ivPart, tagPart, ctPart] = payload.split(".");
      if (
        payload.split(".").length !== 4 ||
        version !== VERSION ||
        !ivPart ||
        !tagPart ||
        !ctPart
      ) {
        throw new Error("Unrecognized Slack token ciphertext format");
      }
      const iv = Buffer.from(ivPart, "base64url");
      const tag = Buffer.from(tagPart, "base64url");
      const ciphertext = Buffer.from(ctPart, "base64url");
      if (iv.length !== IV_BYTES) throw new Error("Slack token ciphertext has an invalid IV");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  };
}
