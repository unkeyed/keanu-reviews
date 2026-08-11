/**
 * Block Kit builders + sanitization (U6). Comment bodies are untrusted GitHub
 * text (KTD11): escaping `&`, `<`, `>` before they enter an mrkdwn block
 * neutralizes Slack control sequences (`<!channel>` becomes inert) and
 * link-injection (`<url|text>`), because Slack only interprets a literal `<`.
 */
export function sanitizeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Truncate long bodies so a giant comment doesn't blow the block limit. */
function clip(text: string, max = 2800): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface ReviewCommentBlockInput {
  body: string;
  permalink: string;
  path: string;
  line: number;
  authorMention: string; // `<@U123>` when mapped, else a plain login
}

/** Mirror of a GitHub review comment: quoted body + an "Open at line" context row. */
export function reviewCommentBlocks(input: ReviewCommentBlockInput): unknown[] {
  const quoted = clip(sanitizeMrkdwn(input.body))
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return [
    { type: "section", text: { type: "mrkdwn", text: quoted } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${input.permalink}|Open> · \`${input.path}:${input.line}\` · by ${input.authorMention}`,
        },
      ],
    },
  ];
}

export interface ReviewSummaryInput {
  state: string; // approved | changes_requested | commented
  body: string;
  htmlUrl: string;
  authorMention: string;
}

const STATE_LABEL: Record<string, string> = {
  approved: "✅ approved",
  changes_requested: "🔄 requested changes",
  commented: "💬 commented",
};

export function reviewSummaryBlocks(input: ReviewSummaryInput): unknown[] {
  const label = STATE_LABEL[input.state] ?? input.state;
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `<${input.htmlUrl}|${label}> by ${input.authorMention}` },
    },
  ];
  if (input.body.trim()) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: clip(sanitizeMrkdwn(input.body)) },
    });
  }
  return blocks;
}
