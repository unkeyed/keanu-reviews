import { describe, expect, it } from "vitest";
import {
  type Message,
  cleanGithubMarkdown,
  extractEmbeddedImages,
  render,
  sanitizeMrkdwn,
} from "./catalog.ts";

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

describe("GitHub body parsing on hostile input", () => {
  // GitHub's 65,536-character comment limit, filled with openers that never close.
  const hostile = (unit: string, tail = "") =>
    unit.repeat(Math.floor((65_536 - tail.length) / unit.length)) + tail;
  const bodies: [string, string][] = [
    ["unclosed img tags", hostile('<img src="')],
    ["unclosed markdown images", hostile("![a](")],
    ["unclosed alt text", hostile("![")],
    ["unclosed links", hostile("<a ")],
    ["unclosed tags", hostile("<b")],
    ["unclosed comments", hostile("<!--")],
    ["unclosed sup blocks", hostile("<sup>")],
    ["trailing spaces without a newline", hostile(" ", "x")],
    ["a URL ending in punctuation runs", `https://x/${hostile(")", "a")}`],
  ];

  it.each(bodies)("handles %s in well under a second", (_name, body) => {
    const start = performance.now();
    cleanGithubMarkdown(body);
    extractEmbeddedImages(body);
    expect(performance.now() - start).toBeLessThan(250);
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

type Block = { type: string; text?: { text: string }; elements?: { text: string }[] };
const blocksOf = (message: Message) => render(message).blocks as Block[];

describe("render review_comment", () => {
  const comment = (over: Partial<Extract<Message, { kind: "review_comment" }>> = {}): Message => ({
    kind: "review_comment",
    path: "a.ts",
    line: 5,
    body: "look here <!channel>",
    url: "https://github.com/o/r/blob/sha/a.ts#L5",
    label: "flo",
    images: [],
    ...over,
  });

  it("quotes a sanitized body and adds an Open-at-line context row", () => {
    const blocks = blocksOf(comment());
    expect(JSON.stringify(blocks)).not.toContain("<!channel>");
    expect(blocks[0]?.text?.text).toBe("> look here &lt;!channel&gt;");
    expect(blocks[1]?.elements?.[0]?.text).toBe(
      "<https://github.com/o/r/blob/sha/a.ts#L5|Open> · `a.ts:5` · by flo",
    );
    expect(render(comment()).text).toBe("New review comment on a.ts:5");
  });

  it("drops the line when there is none and the label when the post shows the author", () => {
    const blocks = blocksOf(comment({ line: null, label: undefined }));
    expect(blocks[1]?.elements?.[0]?.text).toBe(
      "<https://github.com/o/r/blob/sha/a.ts#L5|Open> · `a.ts`",
    );
  });

  it("escapes a hostile label instead of passing markup through", () => {
    const blocks = blocksOf(comment({ label: "<@U1>" }));
    expect(blocks[1]?.elements?.[0]?.text).toContain("· by &lt;@U1&gt;");
  });

  it("enforces the section limit after quote prefixes are rendered", () => {
    const blocks = blocksOf(comment({ body: "x\n".repeat(2_000), label: "safe-user" }));
    expect(blocks[0]?.text?.text?.length).toBeLessThanOrEqual(3_000);
  });

  it("carries the images through for the gateway to append", () => {
    const images = [{ kind: "link" as const, sourceUrl: "https://gh/a", alt: "a" }];
    expect(render(comment({ images })).images).toEqual(images);
  });
});

describe("render", () => {
  const pr = {
    repo: "unkey/api",
    number: 7,
    title: "Fix <b> & stuff",
    url: "https://github.com/unkey/api/pull/7",
    authorLogin: "oz",
    headRef: "feat`x",
    baseRef: "main",
  };

  it("escapes every name and title it shows", () => {
    expect(blocksOf({ kind: "root", pr })[0]?.text?.text).toBe(
      "🔀 *<https://github.com/unkey/api/pull/7|PR #7>* — Fix &lt;b&gt; &amp; stuff\noz wants to merge into `main` from `featˋx`",
    );
    expect(
      blocksOf({ kind: "author_invite", authorLogin: "oz", authorLabel: "<!here>" })[0]?.text?.text,
    ).toBe("👤 Opened by &lt;!here&gt;");
    expect(
      blocksOf({ kind: "review_request", reviewerLogin: "dave", reviewerLabel: "Dave <x>" })[0]
        ?.text?.text,
    ).toBe("👀 Review requested from Dave &lt;x&gt;");
    expect(blocksOf({ kind: "shipped", pr, authorLabel: "Oz" })[0]?.text?.text).toBe(
      "🚢 *<https://github.com/unkey/api/pull/7|unkey/api#7> Fix &lt;b&gt; &amp; stuff* has shipped — by Oz",
    );
  });

  it("marks an unlinked reviewer and pings only on reminders", () => {
    expect(blocksOf({ kind: "review_request", reviewerLogin: "dave" })[0]?.text?.text).toBe(
      "👀 Review requested from `dave` _(no linked Slack user — /link-github to fix)_",
    );
    expect(blocksOf({ kind: "reminder", reviewer: "U9", hours: 12 })[0]?.text?.text).toBe(
      "⏰ <@U9> — this PR has been waiting ~12h for your review.",
    );
    expect(blocksOf({ kind: "reminder", hours: 12 })[0]?.text?.text).toContain(
      "the requested reviewer",
    );
  });

  it("states a lifecycle change and a review verdict", () => {
    expect(
      blocksOf({ kind: "lifecycle", pr, action: "closed", state: "merged" })[0]?.text?.text,
    ).toBe(
      "*<https://github.com/unkey/api/pull/7|#7 Fix &lt;b&gt; &amp; stuff>* — `merged` · by oz",
    );
    const review = render({
      kind: "review",
      authorLogin: "flo",
      state: "approved",
      body: "",
      url: "https://r",
      label: "Flo",
      images: [],
    });
    expect(review.text).toBe("Review approved by flo");
    expect(review.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "<https://r|✅ approved> by Flo" } },
    ]);
  });
});
