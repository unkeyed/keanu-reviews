export type ModelFamily = "claude" | "codex" | "grok";

const FAMILIES: readonly { family: ModelFamily; label: string; pattern: RegExp }[] = [
  {
    family: "claude",
    label: "Claude",
    pattern: /\b(?:claude|anthropic|opus|sonnet|haiku|fable)\b/i,
  },
  { family: "codex", label: "Codex", pattern: /\b(?:codex|gpt|openai|chatgpt)\b/i },
  { family: "grok", label: "Grok", pattern: /\b(?:grok|xai)\b/i },
];

export interface CrossReviewer {
  family: ModelFamily;
  flag: string;
  label: string;
}

// Order is the policy: the first family that did not write the PR reviews it,
// so Codex is also the default when no family is declared.
const REVIEWERS: readonly CrossReviewer[] = [
  { family: "codex", flag: "--codex", label: "Codex" },
  { family: "claude", flag: "--opus", label: "Claude Opus" },
  { family: "grok", flag: "--grok", label: "Grok" },
];

const AGENT_HEADING = /^agent or tool used\b/i;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?[ \t#]*$/;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const PLACEHOLDER = /^\s*[_*]*\s*e\.g\./i;

/** Model families named under the PR template's "Agent or tool used" heading. */
export function authoringFamilies(body: string): Set<ModelFamily> {
  const declared = agentSection(body)
    .filter((line) => !PLACEHOLDER.test(line))
    .join("\n");
  return new Set(FAMILIES.filter((f) => f.pattern.test(declared)).map((f) => f.family));
}

function agentSection(body: string): string[] {
  const section: string[] = [];
  let inSection = false;
  for (const line of body.replace(HTML_COMMENT, "").split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) inSection = AGENT_HEADING.test(heading[1] ?? "");
    else if (inSection) section.push(line);
  }
  return section;
}

export function pickReviewer(families: ReadonlySet<ModelFamily>): CrossReviewer | undefined {
  return REVIEWERS.find((reviewer) => !families.has(reviewer.family));
}

const FENCED_CODE = /(```|~~~)[\s\S]*?(?:\1|$)/g;
const INLINE_CODE = /(`+)[\s\S]*?\1/g;
const PULLFROG_MENTION = /(?<![\w@/])@pullfrog(?![\w-])/i;

/** Whether the text already asks Pullfrog for a run, outside code where GitHub renders no mention. */
export function mentionsPullfrog(body: string): boolean {
  return PULLFROG_MENTION.test(body.replace(FENCED_CODE, "").replace(INLINE_CODE, ""));
}

export function crossReviewBody(
  families: ReadonlySet<ModelFamily>,
  reviewer: CrossReviewer,
): string {
  const declared = FAMILIES.filter((f) => families.has(f.family)).map((f) => f.label);
  const why =
    declared.length === 0
      ? `This PR names no Claude, Codex, or Grok agent under "Agent or tool used", so ${reviewer.label} reviews it by default.`
      : `This PR was written with ${declared.join(" and ")}, so a different model, ${reviewer.label}, reviews it.`;
  return `@pullfrog review ${reviewer.flag}\n\n${why}`;
}
