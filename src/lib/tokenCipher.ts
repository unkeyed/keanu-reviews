import { createCipheriv, createDecipheriv, randomBytes as cryptoRandomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;

export interface TokenCipher {
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
}

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
      const parts = payload.split(".");
      const [version, ivPart, tagPart, ctPart] = parts;
      if (parts.length !== 4 || version !== VERSION || !ivPart || !tagPart || !ctPart) {
        throw new Error("Unrecognized Slack token ciphertext format");
      }
      const iv = Buffer.from(ivPart, "base64url");
      const tag = Buffer.from(tagPart, "base64url");
      const ciphertext = Buffer.from(ctPart, "base64url");
      if (iv.length !== IV_BYTES) throw new Error("Slack token ciphertext has an invalid IV");
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  };
}
