import { describe, expect, it } from "vitest";
import { cleanGithubMarkdown, reviewCommentBlocks, sanitizeMrkdwn } from "./blocks.ts";

describe("cleanGithubMarkdown", () => {
  it("strips a Pullfrog-style body down to the human-readable review", () => {
    const body = [
      "No critical issues — one documentation-contract mismatch remains inline.",
      "",
      "**Reviewed changes** Reviewed the portal identifier changes.",
      "",
      "<!--",
      "Pullfrog review metadata. These findings were written against 6291898ece;",
      "- Mode: IncrementalReview",
      "-->",
      "",
      "<!-- PULLFROG_DIVIDER_DO_NOT_REMOVE_PLZ -->",
      '<sup><a href="https://pullfrog.com"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pullfrog.com/logos/frog-white.png"><img src="https://pullfrog.com/logos/frog.png" width="9px"></picture></a>&nbsp;&nbsp; | Fix all → | Using GPT</sup>',
    ].join("\n");

    const out = cleanGithubMarkdown(body);
    expect(out).toContain("No critical issues");
    expect(out).toContain("**Reviewed changes**");
    // None of the HTML noise survives.
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("PULLFROG_DIVIDER");
    expect(out).not.toContain("<sup>");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("pullfrog.com/logos");
    expect(out).not.toContain("&nbsp;");
    expect(out).not.toContain("Using GPT"); // the whole footer block is gone
  });

  it("keeps the link text when unwrapping an <a> tag", () => {
    expect(cleanGithubMarkdown('see <a href="https://x.com">the docs</a> now')).toBe(
      "see the docs now",
    );
  });

  it("returns empty for a body that is only metadata/footer", () => {
    expect(cleanGithubMarkdown("<!-- only metadata -->\n<sup>footer</sup>")).toBe("");
  });

  it("leaves ordinary markdown untouched", () => {
    const md = "**bold** and a list:\n- one\n- two";
    expect(cleanGithubMarkdown(md)).toBe(md);
  });
});

describe("sanitizeMrkdwn (KTD11)", () => {
  it("neutralizes a broadcast control sequence", () => {
    const out = sanitizeMrkdwn("ship it <!channel> now");
    expect(out).not.toContain("<!channel>");
    expect(out).toContain("&lt;!channel&gt;");
  });

  it("escapes link-injection angle brackets", () => {
    expect(sanitizeMrkdwn("<https://evil|click>")).toBe("&lt;https://evil|click&gt;");
  });
});

describe("reviewCommentBlocks", () => {
  it("quotes a sanitized body and adds an Open-at-line context row", () => {
    const blocks = reviewCommentBlocks({
      body: "look here <!channel>",
      permalink: "https://github.com/o/r/blob/sha/a.ts#L5",
      path: "a.ts",
      line: 5,
      authorMention: "<@U1>",
    }) as { type: string; text?: { text: string }; elements?: { text: string }[] }[];
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain("<!channel>");
    expect(blocks[1]?.elements?.[0]?.text).toContain(
      "<https://github.com/o/r/blob/sha/a.ts#L5|Open>",
    );
    expect(blocks[1]?.elements?.[0]?.text).toContain("`a.ts:5`");
    expect(blocks[1]?.elements?.[0]?.text).toContain("<@U1>");
  });

  it("enforces the section limit after quote prefixes are rendered", () => {
    const blocks = reviewCommentBlocks({
      body: "x\n".repeat(2_000),
      permalink: "https://github.com/o/r/pull/1#discussion_r1",
      path: "a.ts",
      line: 5,
      authorMention: "safe-user",
    }) as { text?: { text?: string } }[];
    expect(blocks[0]?.text?.text?.length).toBeLessThanOrEqual(3_000);
  });
});
