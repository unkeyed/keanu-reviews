/**
 * Block Kit builders + sanitization (U6). Comment bodies are untrusted GitHub
 * text (KTD11): escaping `&`, `<`, `>` before they enter an mrkdwn block
 * neutralizes Slack control sequences (`<!channel>` becomes inert) and
 * link-injection (`<url|text>`), because Slack only interprets a literal `<`.
 */
export function sanitizeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sanitizeInlineCode(text: string): string {
  return sanitizeMrkdwn(text).replace(/`/g, "ˋ");
}

export function sanitizeLinkLabel(text: string): string {
  return sanitizeMrkdwn(text).replace(/\|/g, "¦");
}

export const SLACK_SECTION_TEXT_LIMIT = 3_000;

/** Apply the limit after every prefix, link, and quote marker is rendered. */
export function clipSlackText(text: string, max = SLACK_SECTION_TEXT_LIMIT): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface ReviewCommentBlockInput {
  body: string;
  permalink: string;
  path: string;
  line?: number;
  authorMention: string; // `<@U123>` when mapped, else a plain login
}

/** Mirror of a GitHub review comment: quoted body + an "Open at line" context row. */
export function reviewCommentBlocks(input: ReviewCommentBlockInput): unknown[] {
  const quoted = clipSlackText(
    sanitizeMrkdwn(input.body)
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n"),
  );
  const location = input.line
    ? ` · \`${sanitizeInlineCode(input.path)}:${input.line}\``
    : ` · \`${sanitizeInlineCode(input.path)}\``;
  return [
    { type: "section", text: { type: "mrkdwn", text: quoted } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${input.permalink}|Open>${location} · by ${input.authorMention}`,
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
      text: { type: "mrkdwn", text: clipSlackText(sanitizeMrkdwn(input.body)) },
    });
  }
  return blocks;
}

export function issueCommentBlocks(input: {
  body: string;
  htmlUrl: string;
  authorMention: string;
}): unknown[] {
  const prefix = `💬 <${input.htmlUrl}|comment> by ${input.authorMention}\n`;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: clipSlackText(`${prefix}${sanitizeMrkdwn(input.body)}`),
      },
    },
  ];
}
