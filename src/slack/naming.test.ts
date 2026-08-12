import { describe, expect, it } from "vitest";
import { channelName, slugify } from "./naming.ts";

describe("channelName (KTD7)", () => {
  it("builds a state-repo-number name with the PR title as the readable tail", () => {
    expect(channelName("draft", "unkey/api", 1423, "Add auth")).toBe(
      "draft-unkey-api-1423-add-auth",
    );
    expect(
      channelName("pr", "unkey/api", 1423, "Configure Amp, Orb setup and service portals"),
    ).toBe("pr-unkey-api-1423-configure-amp-orb-setup-and-service-portals");
    expect(channelName("merged", "unkey/api", 1423, "Add auth")).toBe(
      "merged-unkey-api-1423-add-auth",
    );
  });

  it("slugifies repo and title (slashes, dots, uppercase, punctuation)", () => {
    const name = channelName("pr", "Unkey/Go.SDK", 7, "Fix: the thing!");
    expect(name).toBe("pr-unkey-go-sdk-7-fix-the-thing");
    expect(name).toMatch(/^[a-z0-9-_]+$/);
  });

  it("distinguishes different PRs by repo and number", () => {
    expect(channelName("pr", "acme/api", 7, "x")).not.toBe(channelName("pr", "unkey/api", 7, "x"));
    expect(channelName("pr", "unkey/api", 7, "x")).not.toBe(channelName("pr", "unkey/api", 8, "x"));
  });

  it("falls back to just state-repo-number when the title has no slug", () => {
    expect(channelName("pr", "unkey/api", 7, "!!!")).toBe("pr-unkey-api-7");
  });

  it("keeps the total name within Slack's 80-char limit, trimming the title", () => {
    const name = channelName("draft", "unkey/api", 99999, "x".repeat(200));
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.startsWith("draft-unkey-api-99999-")).toBe(true);
  });

  it("slugify collapses separators and trims", () => {
    expect(slugify("  Hello__World--Foo  ")).toBe("hello-world-foo");
  });
});
