import { describe, expect, it } from "vitest";
import { millisecondsUntilUtcHour } from "./background.ts";

describe("millisecondsUntilUtcHour", () => {
  it("waits until the next occurrence, including across a month boundary", () => {
    expect(millisecondsUntilUtcHour(new Date("2026-10-16T07:59:59.000Z"), 8)).toBe(1000);
    expect(millisecondsUntilUtcHour(new Date("2026-10-16T08:00:00.000Z"), 8)).toBe(
      24 * 60 * 60_000,
    );
    expect(millisecondsUntilUtcHour(new Date("2026-10-31T09:00:00.000Z"), 8)).toBe(
      23 * 60 * 60_000,
    );
  });
});
