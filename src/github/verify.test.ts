import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignature } from "./verify.ts";

const sign = (body: string, secret: string): string =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

const SECRET = "whsec_test";
const BODY = JSON.stringify({ action: "opened", number: 1 });

describe("verifySignature", () => {
  it("accepts a valid signature over the raw body", () => {
    expect(verifySignature(BODY, sign(BODY, SECRET), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = sign(BODY, SECRET);
    expect(verifySignature(`${BODY} `, sig, SECRET)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifySignature(BODY, undefined, SECRET)).toBe(false);
  });

  it("rejects a legacy SHA-1 (sha1=) signature", () => {
    const legacy = `sha1=${createHmac("sha1", SECRET).update(BODY).digest("hex")}`;
    expect(verifySignature(BODY, legacy, SECRET)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    expect(verifySignature(BODY, sign(BODY, "wrong"), SECRET)).toBe(false);
  });
});
