import type { SlackBlock } from "./client.ts";

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

/**
 * Clean a GitHub comment/review body for Slack. GitHub bodies (especially from
 * review bots like Pullfrog) embed HTML that Slack's mrkdwn can't render — HTML
 * comments carrying machine metadata, `<sup>` marketing footers, `<picture>`/
 * `<img>` logos, and `<a>` link wrappers. Left as-is they'd be escaped and shown
 * verbatim, so we strip them to the human-readable text before sanitizing.
 */
export function cleanGithubMarkdown(body: string): string {
  return (
    body
      // Metadata + divider markers GitHub bots hide in HTML comments.
      .replace(/<!--[\s\S]*?-->/g, "")
      // The whole `<sup>…</sup>` marketing/footer block (logos, "Fix all" links).
      .replace(/<sup>[\s\S]*?<\/sup>/gi, "")
      // Media/void elements have no text to keep.
      .replace(/<(?:picture|source|img)\b[^>]*>/gi, "")
      .replace(/<\/(?:picture|source)>/gi, "")
      // Keep the link text, drop the <a> wrapper (URLs are usually in the text).
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
      // Any remaining stray tags.
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      // Non-breaking spaces GitHub emits in footers.
      .replace(/&nbsp;/gi, " ")
      // Collapse the blank space the removals leave behind.
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
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
  // Plain author label appended as "· by …". Omit when the message is authored
  // as the Slack user (username override), which already shows who wrote it.
  authorMention?: string;
}

/** Mirror of a GitHub review comment: quoted body + an "Open at line" context row. */
export function reviewCommentBlocks(input: ReviewCommentBlockInput): SlackBlock[] {
  const quoted = clipSlackText(
    sanitizeMrkdwn(cleanGithubMarkdown(input.body))
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
          text: `<${input.permalink}|Open>${location}${input.authorMention ? ` · by ${input.authorMention}` : ""}`,
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

export function reviewSummaryBlocks(input: ReviewSummaryInput): SlackBlock[] {
  const label = STATE_LABEL[input.state] ?? input.state;
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `<${input.htmlUrl}|${label}> by ${input.authorMention}` },
    },
  ];
  const cleaned = cleanGithubMarkdown(input.body);
  if (cleaned) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: clipSlackText(sanitizeMrkdwn(cleaned)) },
    });
  }
  return blocks;
}

export function issueCommentBlocks(input: {
  body: string;
  htmlUrl: string;
  // Omit when authored as the Slack user (username override shows the author).
  authorMention?: string;
}): SlackBlock[] {
  const prefix = `💬 <${input.htmlUrl}|comment>${input.authorMention ? ` by ${input.authorMention}` : ""}\n`;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: clipSlackText(`${prefix}${sanitizeMrkdwn(cleanGithubMarkdown(input.body))}`),
      },
    },
  ];
}
