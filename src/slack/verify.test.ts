import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "./verify.ts";

const SECRET = "slack_signing_secret";
const sign = (ts: string, body: string): string =>
  `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`, "utf8").digest("hex")}`;

const NOW = 1_700_000_000_000;
const now = () => NOW;
const TS = String(Math.floor(NOW / 1000));
const BODY = "user_id=U1&text=octocat";

describe("verifySlackSignature (U9)", () => {
  it("accepts a valid, fresh signature", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: TS,
        rawBody: BODY,
        signature: sign(TS, BODY),
        now,
      }),
    ).toBe(true);
  });

  it("rejects a stale timestamp (replay guard)", () => {
    const oldTs = String(Math.floor(NOW / 1000) - 600); // 10 min old
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: oldTs,
        rawBody: BODY,
        signature: sign(oldTs, BODY),
        now,
      }),
    ).toBe(false);
  });

  it("rejects a tampered body / wrong signature", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: TS,
        rawBody: `${BODY}&x=1`,
        signature: sign(TS, BODY),
        now,
      }),
    ).toBe(false);
  });
});
