import { describe, expect, it } from "vitest";
import { CURRENT_CHANNEL_NAME_VERSION, channelName, slugify } from "./naming.ts";

describe("channelName v3 (current: state-number-author-repo-title)", () => {
  it("puts the PR number right after the state, then author, repo, and title", () => {
    expect(
      channelName({
        state: "draft",
        repoFullName: "unkey/api",
        number: 1423,
        title: "Add auth",
        author: "alice",
      }),
    ).toBe("draft-1423-alice-unkey-api-add-auth");
    expect(
      channelName({
        state: "pr",
        repoFullName: "unkeyed/unkey",
        number: 8573,
        title: "Fix ctrl break",
        author: "flo4604",
      }),
    ).toBe("pr-8573-flo4604-unkeyed-unkey-fix-ctrl-break");
    expect(
      channelName({
        state: "merged",
        repoFullName: "unkey/api",
        number: 1423,
        title: "Add auth",
        author: "alice",
      }),
    ).toBe("merged-1423-alice-unkey-api-add-auth");
    expect(
      channelName({
        state: "closed",
        repoFullName: "unkey/api",
        number: 1423,
        title: "Add auth",
        author: "alice",
      }),
    ).toBe("closed-1423-alice-unkey-api-add-auth");
  });

  it("defaults to the current scheme when no version is passed", () => {
    expect(CURRENT_CHANNEL_NAME_VERSION).toBe(3);
    expect(
      channelName({ state: "pr", repoFullName: "unkey/api", number: 7, title: "x", author: "bob" }),
    ).toBe("pr-7-bob-unkey-api-x");
  });

  it("falls back to the current scheme for a version it does not know", () => {
    expect(
      channelName({
        version: 99,
        state: "pr",
        repoFullName: "unkey/api",
        number: 7,
        title: "x",
        author: "bob",
      }),
    ).toBe("pr-7-bob-unkey-api-x");
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
    ).toBe("pr-7-renovate-bot-unkey-api-x");
    expect(
      channelName({ state: "pr", repoFullName: "unkey/api", number: 7, title: "x", author: "" }),
    ).toBe("pr-7-unknown-unkey-api-x");
    expect(channelName({ state: "pr", repoFullName: "unkey/api", number: 7, title: "x" })).toBe(
      "pr-7-unknown-unkey-api-x",
    );
  });

  it("slugifies repo and title (slashes, dots, uppercase, punctuation)", () => {
    const name = channelName({
      state: "pr",
      repoFullName: "Unkey/Go.SDK",
      number: 7,
      title: "Fix: the thing!",
      author: "alice",
    });
    expect(name).toBe("pr-7-alice-unkey-go-sdk-fix-the-thing");
    expect(name).toMatch(/^[a-z0-9-_]+$/);
  });

  it("falls back to just state-number-author-repo when the title has no slug", () => {
    expect(
      channelName({ state: "pr", repoFullName: "unkey/api", number: 7, title: "!!!", author: "a" }),
    ).toBe("pr-7-a-unkey-api");
  });

  it("keeps the total name within Slack's 80-char limit, trimming the title", () => {
    const name = channelName({
      state: "draft",
      repoFullName: "unkey/api",
      number: 99999,
      title: "x".repeat(200),
      author: "alice",
    });
    expect(name).toHaveLength(80);
    expect(name).toBe(`draft-99999-alice-unkey-api-${"x".repeat(52)}`);
  });

  it("keeps state, number, and author when a long repo name eats the budget", () => {
    const name = channelName({
      state: "draft",
      repoFullName: `unkey/${"r".repeat(100)}`,
      number: 99999,
      title: "Add auth",
      author: "alice",
    });
    expect(name).toHaveLength(80);
    expect(name).toBe(`draft-99999-alice-unkey-${"r".repeat(56)}`);
  });
});

describe("channelName v2 (legacy: state-author-repo-number-title)", () => {
  it("matches the v2 format byte-for-byte", () => {
    expect(
      channelName({
        version: 2,
        state: "draft",
        repoFullName: "unkey/api",
        number: 1423,
        title: "Add auth",
        author: "alice",
      }),
    ).toBe("draft-alice-unkey-api-1423-add-auth");
    expect(
      channelName({
        version: 2,
        state: "pr",
        repoFullName: "unkey/api",
        number: 1423,
        title: "Configure Amp, Orb setup and service portals",
        author: "alice",
      }),
    ).toBe("pr-alice-unkey-api-1423-configure-amp-orb-setup-and-service-portals");
    expect(
      channelName({
        version: 2,
        state: "merged",
        repoFullName: "unkey/api",
        number: 1423,
        title: "Add auth",
        author: "alice",
      }),
    ).toBe("merged-alice-unkey-api-1423-add-auth");
  });

  it("slugifies the author and falls back when missing", () => {
    expect(
      channelName({
        version: 2,
        state: "pr",
        repoFullName: "unkey/api",
        number: 7,
        title: "x",
        author: "Renovate[bot]",
      }),
    ).toBe("pr-renovate-bot-unkey-api-7-x");
    expect(
      channelName({
        version: 2,
        state: "pr",
        repoFullName: "unkey/api",
        number: 7,
        title: "x",
        author: "",
      }),
    ).toBe("pr-unknown-unkey-api-7-x");
  });

  it("keeps the total name within Slack's 80-char limit, trimming the title", () => {
    const name = channelName({
      version: 2,
      state: "draft",
      repoFullName: "unkey/api",
      number: 99999,
      title: "x".repeat(200),
      author: "alice",
    });
    expect(name).toHaveLength(80);
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
