import { describe, expect, it } from "vitest";
import { normalizeBotName, shouldSkipActor } from "./actors.ts";

describe("normalizeBotName", () => {
  it("lowercases and strips the [bot] suffix", () => {
    expect(normalizeBotName("Pullfrog[bot]")).toBe("pullfrog");
    expect(normalizeBotName("  DEPENDABOT  ")).toBe("dependabot");
    expect(normalizeBotName("flo")).toBe("flo");
  });
});

describe("shouldSkipActor", () => {
  const allow = new Set(["pullfrog"]);

  it("never skips human actors", () => {
    expect(shouldSkipActor({ type: "User", login: "meg" }, allow)).toBe(false);
    expect(shouldSkipActor({ login: "meg" }, allow)).toBe(false);
  });

  it("skips bots that are not allow-listed", () => {
    expect(shouldSkipActor({ type: "Bot", login: "vercel[bot]" }, allow)).toBe(true);
    expect(shouldSkipActor({ type: "Bot", login: "dependabot[bot]" })).toBe(true); // empty allowlist
  });

  it("mirrors an allow-listed bot regardless of the [bot] suffix or case", () => {
    expect(shouldSkipActor({ type: "Bot", login: "pullfrog[bot]" }, allow)).toBe(false);
    expect(shouldSkipActor({ type: "Bot", login: "Pullfrog" }, allow)).toBe(false);
  });

  it("skips a bot with no login even if the allowlist is non-empty", () => {
    expect(shouldSkipActor({ type: "Bot" }, allow)).toBe(true);
  });
});
