import { describe, expect, it } from "vitest";
import {
  cleanGithubMarkdown,
  extractEmbeddedImages,
  imageBlocks,
  reviewCommentBlocks,
  sanitizeMrkdwn,
} from "./blocks.ts";

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

  it("strips markdown image syntax from the text (shown as image blocks instead)", () => {
    expect(cleanGithubMarkdown("see this ![a screenshot](https://x.com/a.png) here")).toBe(
      "see this  here",
    );
  });
});

describe("extractEmbeddedImages", () => {
  it("pulls markdown image url + alt text", () => {
    expect(extractEmbeddedImages("look ![the diff](https://img.example.com/a.png)")).toEqual([
      { url: "https://img.example.com/a.png", alt: "the diff" },
    ]);
  });

  it("pulls an HTML <img> src and alt", () => {
    expect(
      extractEmbeddedImages('<img alt="chart" src="https://img.example.com/b.jpg" width="40">'),
    ).toEqual([{ url: "https://img.example.com/b.jpg", alt: "chart" }]);
  });

  it("pulls a bare image-file URL and trims trailing punctuation", () => {
    expect(extractEmbeddedImages("(see https://img.example.com/c.gif).")).toEqual([
      { url: "https://img.example.com/c.gif", alt: "image" },
    ]);
  });

  it("ignores non-image bare URLs and de-dupes across forms", () => {
    const body =
      "docs https://example.com/page ![x](https://img.example.com/a.png) https://img.example.com/a.png";
    expect(extractEmbeddedImages(body)).toEqual([
      { url: "https://img.example.com/a.png", alt: "x" },
    ]);
  });

  it("skips malformed / non-http URLs and caps the count", () => {
    expect(extractEmbeddedImages("![bad](javascript:alert(1).png)")).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) => `![n](https://img.example.com/${i}.png)`).join(
      " ",
    );
    expect(extractEmbeddedImages(many)).toHaveLength(5);
    expect(extractEmbeddedImages(many, 2)).toHaveLength(2);
  });

  it("defaults alt text to 'image' when none is given", () => {
    expect(extractEmbeddedImages("![](https://img.example.com/d.webp)")[0]?.alt).toBe("image");
  });
});

describe("imageBlocks", () => {
  it("builds Slack image blocks with required alt_text", () => {
    expect(imageBlocks([{ url: "https://img.example.com/a.png", alt: "diagram" }])).toEqual([
      { type: "image", image_url: "https://img.example.com/a.png", alt_text: "diagram" },
    ]);
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
