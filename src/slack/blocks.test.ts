import { describe, expect, it } from "vitest";
import { reviewCommentBlocks, sanitizeMrkdwn } from "./blocks.ts";

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
