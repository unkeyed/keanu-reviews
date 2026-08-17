import { describe, expect, it } from "vitest";
import { createTokenCipher } from "./tokenCipher.ts";

// 32-byte key expressed three ways; all must be accepted.
const HEX_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const cipher = createTokenCipher(HEX_KEY);

describe("Slack token cipher", () => {
  it("round-trips a token through encrypt/decrypt", () => {
    const token = "xoxp-123456789012-abcdefghijklmnop";
    const payload = cipher.encrypt(token);
    expect(payload).not.toContain(token); // never stored in plaintext
    expect(payload.startsWith("v1.")).toBe(true);
    expect(cipher.decrypt(payload)).toBe(token);
  });

  it("produces a fresh IV per call so identical tokens differ on disk", () => {
    const a = cipher.encrypt("xoxp-same");
    const b = cipher.encrypt("xoxp-same");
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe("xoxp-same");
    expect(cipher.decrypt(b)).toBe("xoxp-same");
  });

  it("rejects a tampered ciphertext instead of returning garbage", () => {
    const payload = cipher.encrypt("xoxp-secret");
    const [v, iv, tag, ct] = payload.split(".") as [string, string, string, string];
    // Flip a real byte of the ciphertext (not a base64 char, which can be
    // non-canonical and decode unchanged) so GCM authentication must fail.
    const bytes = Buffer.from(ct, "base64url");
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0);
    const flipped = bytes.toString("base64url");
    expect(() => cipher.decrypt([v, iv, tag, flipped].join("."))).toThrow();
  });

  it("cannot decrypt what another key encrypted", () => {
    const other = createTokenCipher(
      "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
    );
    expect(() => other.decrypt(cipher.encrypt("xoxp-secret"))).toThrow();
  });

  it("accepts hex, base64, and base64url keys of 32 bytes but rejects short keys", () => {
    const raw = Buffer.from(HEX_KEY, "hex");
    expect(() => createTokenCipher(raw.toString("base64"))).not.toThrow();
    expect(() => createTokenCipher(raw.toString("base64url"))).not.toThrow();
    expect(() => createTokenCipher("tooshort")).toThrow(/32 bytes/);
  });

  it("rejects an unrecognized ciphertext format", () => {
    expect(() => cipher.decrypt("v2.a.b.c")).toThrow(/format/);
    expect(() => cipher.decrypt("not-a-payload")).toThrow(/format/);
  });
});
