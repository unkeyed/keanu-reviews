import { describe, expect, it } from "vitest";
import { channelName, slugify } from "./naming.ts";

describe("channelName (KTD7)", () => {
  it("builds a stable state-owner-repo-number name with an identity digest", () => {
    expect(channelName("draft", "unkey/api", 1423)).toBe("draft-unkey-api-1423-19ec85a8");
    expect(channelName("pr", "unkey/api", 1423)).toBe("pr-unkey-api-1423-19ec85a8");
    expect(channelName("merged", "unkey/api", 1423)).toBe("merged-unkey-api-1423-19ec85a8");
  });

  it("slugifies repo names with slashes, dots, and uppercase", () => {
    const name = channelName("pr", "Unkey/Go.SDK", 7);
    expect(name).toBe("pr-unkey-go-sdk-7-47d1f1e8");
    expect(name).toMatch(/^[a-z0-9-_]+$/);
  });

  it("does not collide for repositories with the same name or equivalent slugs", () => {
    expect(channelName("pr", "acme/api", 7)).not.toBe(channelName("pr", "unkey/api", 7));
    expect(channelName("pr", "unkey/go.sdk", 7)).not.toBe(channelName("pr", "unkey/go-sdk", 7));
  });

  it("keeps the total name within Slack's 80-char limit", () => {
    const longRepo = `owner/${"x".repeat(200)}`;
    const name = channelName("draft", longRepo, 99999);
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.startsWith("draft-")).toBe(true);
    expect(name).toMatch(/-99999-[0-9a-f]{8}$/);
  });

  it("slugify collapses separators and trims", () => {
    expect(slugify("  Hello__World--Foo  ")).toBe("hello-world-foo");
  });
});
