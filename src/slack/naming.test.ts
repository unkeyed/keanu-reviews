import { describe, expect, it } from "vitest";
import { CURRENT_CHANNEL_NAME_VERSION, channelName, slugify } from "./naming.ts";

describe("channelName v2 (current: state-author-repo-number-title)", () => {
  it("builds a state-author-repo-number name with the PR title as the readable tail", () => {
    expect(
      channelName({
        state: "draft",
        repoFullName: "unkey/api",
        number: 1423,
        title: "Add auth",
        author: "alice",
      }),
    ).toBe("draft-alice-unkey-api-1423-add-auth");
    expect(
      channelName({
        state: "pr",
        repoFullName: "unkey/api",
        number: 1423,
        title: "Configure Amp, Orb setup and service portals",
        author: "alice",
      }),
    ).toBe("pr-alice-unkey-api-1423-configure-amp-orb-setup-and-service-portals");
    expect(
      channelName({
        state: "merged",
        repoFullName: "unkey/api",
        number: 1423,
        title: "Add auth",
        author: "alice",
      }),
    ).toBe("merged-alice-unkey-api-1423-add-auth");
  });

  it("defaults to the current scheme when no version is passed", () => {
    expect(CURRENT_CHANNEL_NAME_VERSION).toBe(2);
    expect(
      channelName({ state: "pr", repoFullName: "unkey/api", number: 7, title: "x", author: "bob" }),
    ).toBe("pr-bob-unkey-api-7-x");
  });

  it("slugifies the author (uppercase, punctuation) and falls back when missing", () => {
    expect(
      channelName({
        state: "pr",
        repoFullName: "unkey/api",
        number: 7,
        title: "x",
        author: "Renovate[bot]",
      }),
    ).toBe("pr-renovate-bot-unkey-api-7-x");
    expect(
      channelName({ state: "pr", repoFullName: "unkey/api", number: 7, title: "x", author: "" }),
    ).toBe("pr-unknown-unkey-api-7-x");
  });

  it("slugifies repo and title (slashes, dots, uppercase, punctuation)", () => {
    const name = channelName({
      state: "pr",
      repoFullName: "Unkey/Go.SDK",
      number: 7,
      title: "Fix: the thing!",
      author: "alice",
    });
    expect(name).toBe("pr-alice-unkey-go-sdk-7-fix-the-thing");
    expect(name).toMatch(/^[a-z0-9-_]+$/);
  });

  it("keeps the total name within Slack's 80-char limit, trimming the title", () => {
    const name = channelName({
      state: "draft",
      repoFullName: "unkey/api",
      number: 99999,
      title: "x".repeat(200),
      author: "alice",
    });
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.startsWith("draft-alice-unkey-api-99999-")).toBe(true);
  });
});

describe("channelName v1 (legacy: state-repo-number-title, no author)", () => {
  it("omits the author and matches the pre-v2 format byte-for-byte", () => {
    expect(
      channelName({
        version: 1,
        state: "draft",
        repoFullName: "unkey/api",
        number: 1423,
        title: "Add auth",
        author: "alice",
      }),
    ).toBe("draft-unkey-api-1423-add-auth");
    expect(
      channelName({
        version: 1,
        state: "merged",
        repoFullName: "unkey/api",
        number: 1423,
        title: "Add auth",
      }),
    ).toBe("merged-unkey-api-1423-add-auth");
  });

  it("falls back to just state-repo-number when the title has no slug", () => {
    expect(
      channelName({ version: 1, state: "pr", repoFullName: "unkey/api", number: 7, title: "!!!" }),
    ).toBe("pr-unkey-api-7");
  });
});

describe("channelName distinguishes PRs regardless of scheme", () => {
  it("distinguishes different PRs by repo and number", () => {
    expect(
      channelName({ state: "pr", repoFullName: "acme/api", number: 7, title: "x", author: "a" }),
    ).not.toBe(
      channelName({ state: "pr", repoFullName: "unkey/api", number: 7, title: "x", author: "a" }),
    );
    expect(
      channelName({ state: "pr", repoFullName: "unkey/api", number: 7, title: "x", author: "a" }),
    ).not.toBe(
      channelName({ state: "pr", repoFullName: "unkey/api", number: 8, title: "x", author: "a" }),
    );
  });

  it("slugify collapses separators and trims", () => {
    expect(slugify("  Hello__World--Foo  ")).toBe("hello-world-foo");
  });
});
