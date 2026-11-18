import { describe, expect, it } from "vitest";
import {
  authoringFamilies,
  crossReviewBody,
  mentionsPullfrog,
  pickReviewer,
} from "./crossReview.ts";

const template = (declared: string, around = { before: "", after: "" }) => `## Summary
Adds a cache. ${around.before}

## Agent or tool used
<!-- Name the agent or tool that wrote most of this PR, e.g. Claude Code or Codex. -->
_e.g. Cursor agent, Claude Code, none._

${declared}

## Testing
Unit tests. ${around.after}
`;

const flagFor = (body: string) => pickReviewer(authoringFamilies(body))?.flag;

describe("cross-model reviewer", () => {
  it.each([
    ["Claude Code", "--codex"],
    ["claude opus 4.5", "--codex"],
    ["Anthropic Sonnet", "--codex"],
    ["Codex", "--opus"],
    ["GPT-5 via ChatGPT", "--opus"],
    ["OpenAI codex cli", "--opus"],
    ["Grok", "--codex"],
    ["xAI grok-code", "--codex"],
    ["none", "--codex"],
    ["Cursor agent", "--codex"],
    ["Amp", "--codex"],
  ])("a PR written with %s is reviewed with %s", (declared, flag) => {
    expect(flagFor(template(declared))).toBe(flag);
  });

  it("does not read the template's placeholder line or comment as a declaration", () => {
    expect(authoringFamilies(template(""))).toEqual(new Set());
    expect(flagFor(template(""))).toBe("--codex");
    expect(flagFor(template("**e.g. Claude Code**\n\nCodex"))).toBe("--opus");
  });

  it("ignores model names outside the agent section", () => {
    const body = template("Cursor agent", {
      before: "Inspired by a Claude chat.",
      after: "Also ran a Codex review.",
    });
    expect(authoringFamilies(body)).toEqual(new Set());
  });

  it("falls back to Codex when the PR has no agent section", () => {
    expect(flagFor("Fixes a typo that Claude found.")).toBe("--codex");
    expect(flagFor("")).toBe("--codex");
  });

  it("finds the section at any heading level and case", () => {
    expect(flagFor("### AGENT OR TOOL USED:\nCodex\n### Notes\nclaude")).toBe("--opus");
    expect(flagFor("# Agent or tool used\r\nGPT\r\n")).toBe("--opus");
  });

  it("picks the first family that wrote none of a multi-agent PR", () => {
    expect(flagFor(template("Claude Code and Codex"))).toBe("--grok");
    expect(flagFor(template("Codex, then Grok"))).toBe("--opus");
    expect(flagFor(template("Claude, Codex and Grok"))).toBeUndefined();
  });

  it("does not match model names inside other words", () => {
    expect(authoringFamilies(template("Copus, Groken, Codexify"))).toEqual(new Set());
  });
});

describe("mentionsPullfrog", () => {
  it.each([
    ["@pullfrog review this", true],
    ["Please ask @Pullfrog.", true],
    ["(@pullfrog --codex)", true],
    ["Run `@pullfrog review` after merging", false],
    ["```\n@pullfrog review\n```\nnothing else", false],
    ["~~~sh\n@pullfrog\n~~~", false],
    ["mail ops@pullfrog.com", false],
    ["ping @pullfrog-bot", false],
    ["no mention", false],
  ])("%j -> %s", (body, expected) => {
    expect(mentionsPullfrog(body)).toBe(expected);
  });

  it("still sees a mention after a closed code fence", () => {
    expect(mentionsPullfrog("```\ncode\n```\n@pullfrog review")).toBe(true);
  });
});

describe("crossReviewBody", () => {
  it("opens with the Pullfrog mention and flag, then says why", () => {
    const families = authoringFamilies(template("Claude Code"));
    const reviewer = pickReviewer(families);
    if (!reviewer) throw new Error("expected a reviewer");
    const body = crossReviewBody(families, reviewer);
    expect(body.split("\n")[0]).toBe("@pullfrog review --codex");
    expect(body).toContain("written with Claude");
    expect(body).toContain("Codex");
  });

  it("says the default reviewer was used when no agent is declared", () => {
    const reviewer = pickReviewer(new Set());
    if (!reviewer) throw new Error("expected a reviewer");
    const body = crossReviewBody(new Set(), reviewer);
    expect(body.split("\n")[0]).toBe("@pullfrog review --codex");
    expect(body).toContain("by default");
  });
});
