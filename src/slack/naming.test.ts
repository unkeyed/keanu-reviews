import { describe, expect, it } from "vitest";
import { channelName, slugify } from "./naming.ts";

describe("channelName (KTD7)", () => {
  it("builds <state>-<repo>-<number> lowercased", () => {
    expect(channelName("draft", "unkey/api", 1423)).toBe("draft-api-1423");
    expect(channelName("pr", "unkey/api", 1423)).toBe("pr-api-1423");
    expect(channelName("merged", "unkey/api", 1423)).toBe("merged-api-1423");
  });

  it("slugifies repo names with slashes, dots, and uppercase", () => {
    const name = channelName("pr", "Unkey/Go.SDK", 7);
    expect(name).toBe("pr-go-sdk-7");
    expect(name).toMatch(/^[a-z0-9-_]+$/);
  });

  it("keeps the total name within Slack's 80-char limit", () => {
    const longRepo = `owner/${"x".repeat(200)}`;
    const name = channelName("draft", longRepo, 99999);
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.startsWith("draft-")).toBe(true);
    expect(name.endsWith("-99999")).toBe(true);
  });

  it("slugify collapses separators and trims", () => {
    expect(slugify("  Hello__World--Foo  ")).toBe("hello-world-foo");
  });
});
