import type { ChatPostMessageArguments } from "@slack/web-api";
import type { PrState } from "#events";
import type { PrId } from "#lib";
import type { RenderedMessage } from "./gateway.ts";

type ChatPostMessageWithBlocks = Extract<ChatPostMessageArguments, { blocks: unknown[] }>;
export type SlackBlock = ChatPostMessageWithBlocks["blocks"][number];

export type MessageImage =
  | { kind: "embed"; imageUrl: string; sourceUrl: string; alt: string }
  | { kind: "link"; sourceUrl: string; alt: string };

export function sanitizeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sanitizeInlineCode(text: string): string {
  return sanitizeMrkdwn(text).replace(/`/g, "ˋ");
}

export function sanitizeLinkLabel(text: string): string {
  return sanitizeMrkdwn(text).replace(/\|/g, "¦");
}

export function cleanGithubMarkdown(body: string): string {
  return stripHtmlComments(body)
    .replace(/<sup>(?:[^<]|<(?!sup>))*?<\/sup>/gi, "")
    .replace(/!\[[^[\]]*\]\([^()]*\)/g, "")
    .replace(/<\/?[a-zA-Z][^<>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/(?<![ \t])[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^`]*)$/;

/**
 * Converts a GitHub comment body to Slack mrkdwn. Fences of any length become
 * Slack code blocks. Links, emphasis, headings, bullets and quotes are
 * rewritten into Slack's syntax. With `quote`, prose lines are block-quoted,
 * but code blocks are not: Slack shows a `>` inside a code block as literal text.
 */
export function githubToMrkdwn(body: string, opts: { quote?: boolean } = {}): string {
  const lines = stripHtmlComments(body)
    .replace(/<summary>\s*([\s\S]*?)\s*<\/summary>/gi, "\n**$1**\n")
    .split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    const cleaned = cleanGithubMarkdown(prose.join("\n"));
    prose = [];
    if (!cleaned) return;
    for (const line of cleaned.split("\n")) {
      const converted = proseLine(line);
      out.push(opts.quote ? `> ${converted.replace(/^> /, "")}` : converted);
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i] ?? "");
    if (!open?.[1]) {
      prose.push(lines[i] ?? "");
      continue;
    }
    flushProse();
    const marker = open[1];
    const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
    const code: string[] = [];
    for (i++; i < lines.length && !close.test(lines[i] ?? ""); i++) code.push(lines[i] ?? "");
    out.push(`\`\`\`\n${sanitizeMrkdwn(code.join("\n")).replace(/```/g, "ˋˋˋ")}\n\`\`\``);
  }
  flushProse();
  return out.join("\n").trim();
}

const ALERT = /^\[!(note|tip|important|warning|caution)\]$/i;

function proseLine(line: string): string {
  const quoted = /^\s*(?:>\s?)+/.exec(line);
  let text = quoted ? line.slice(quoted[0].length) : line;
  const alert = ALERT.exec(text.trim());
  if (alert?.[1]) text = `**${alert[1][0]?.toUpperCase()}${alert[1].slice(1).toLowerCase()}**`;
  text = text.replace(/^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/, "**$1**").replace(/^(\s*)[-*+]\s+/, "$1• ");
  return `${quoted ? "> " : ""}${withLinks(text)}`;
}

const MD_LINK = /\[([^[\]\n]+)\]\((https?:\/\/[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)/g;

function withLinks(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(MD_LINK)) {
    const [whole, label = "", url = ""] = m;
    out += withInlineCode(text.slice(last, m.index));
    out += `<${sanitizeMrkdwn(url).replace(/\|/g, "%7C")}|${sanitizeLinkLabel(label.replace(/`/g, ""))}>`;
    last = (m.index ?? 0) + whole.length;
  }
  return out + withInlineCode(text.slice(last));
}

function withInlineCode(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) => (i % 2 === 1 ? sanitizeMrkdwn(part) : emphasis(sanitizeMrkdwn(part))))
    .join("");
}

function emphasis(text: string): string {
  return text
    .replace(/(?<![*\w])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![*\w])/g, "_$1_")
    .replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, "*$1*")
    .replace(/(?<!\w)__(?!\s)([^_\n]+?)(?<!\s)__(?!\w)/g, "*$1*")
    .replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, "~$1~");
}

function stripHtmlComments(body: string): string {
  const end = body.lastIndexOf("-->");
  if (end < 0) return body;
  return body.slice(0, end + 3).replace(/<!--[\s\S]*?-->/g, "") + body.slice(end + 3);
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#]|$)/i;

export interface EmbeddedImage {
  url: string;
  alt: string;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function extractEmbeddedImages(body: string, max = 5): EmbeddedImage[] {
  const out: EmbeddedImage[] = [];
  const seen = new Set<string>();
  const add = (rawUrl: string, alt: string) => {
    const url = rawUrl.trim();
    if (!isHttpUrl(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, alt: alt.trim() || "image" });
  };
  for (const m of body.matchAll(/!\[([^[\]]*)\]\(\s*([^()\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
    add(m[2] ?? "", m[1] ?? "");
  }
  for (const m of body.matchAll(/<img\b[^<>]*?\bsrc=["']([^"']+)["'][^<>]*>/gi)) {
    const alt = /\balt=["']([^"']*)["']/i.exec(m[0]);
    add(m[1] ?? "", alt?.[1] ?? "");
  }
  for (const m of body.matchAll(/https?:\/\/\S+/gi)) {
    const url = (m[0] ?? "").replace(/(?<![)\].,;:!'"])[)\].,;:!'"]+$/, "");
    if (IMAGE_EXT_RE.test(url)) add(url, "");
  }
  return out.slice(0, max);
}

export const SLACK_SECTION_TEXT_LIMIT = 3_000;

function clipSlackText(text: string): string {
  if (text.length <= SLACK_SECTION_TEXT_LIMIT) return text;
  const clipped = `${text.slice(0, SLACK_SECTION_TEXT_LIMIT - 5)}…`;
  // A cut inside a code block would leave the rest of the message unformatted.
  return (clipped.match(/```/g) ?? []).length % 2 === 1 ? `${clipped}\n\`\`\`` : clipped;
}

export interface PrView {
  repo: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string;
  headRef?: string | null;
  baseRef?: string | null;
}

export type Message =
  | { kind: "root"; pr: PrView }
  | { kind: "author_invite"; authorLogin: string; authorLabel: string }
  | { kind: "lifecycle"; pr: PrView; action: string; state: PrState }
  | {
      kind: "review_comment";
      path: string;
      line: number | null;
      body: string;
      url: string;
      label?: string;
      images: readonly MessageImage[];
    }
  | {
      kind: "issue_comment";
      authorLogin: string;
      body: string;
      url: string;
      label?: string;
      images: readonly MessageImage[];
    }
  | {
      kind: "review";
      authorLogin: string;
      state: string;
      body: string;
      url: string;
      label?: string;
      images: readonly MessageImage[];
    }
  | { kind: "review_request"; reviewerLogin: string; reviewerLabel?: string }
  | { kind: "reminder"; reviewer?: string; hours: number }
  | { kind: "shipped"; pr: PrView; authorLabel: string };

export type LedgerKind =
  | "root"
  | "author_invite"
  | "lifecycle"
  | "review_comment"
  | "issue_comment"
  | "review"
  | "invite"
  | "reminder"
  | "shipped";

export interface EffectKey {
  readonly prId: PrId;
  readonly kind: LedgerKind;
  readonly ref: string;
}

export const keys = {
  root: (prId: PrId): EffectKey => ({ prId, kind: "root", ref: "root" }),
  authorInvite: (prId: PrId, authorGithubId: number): EffectKey => ({
    prId,
    kind: "author_invite",
    ref: String(authorGithubId),
  }),
  lifecycle: (
    prId: PrId,
    action: string,
    state: PrState,
    headSha: string,
    updatedAt: string,
  ): EffectKey => ({ prId, kind: "lifecycle", ref: `${action}:${state}:${headSha}:${updatedAt}` }),
  reviewComment: (prId: PrId, commentId: number): EffectKey => ({
    prId,
    kind: "review_comment",
    ref: String(commentId),
  }),
  issueComment: (prId: PrId, commentId: number): EffectKey => ({
    prId,
    kind: "issue_comment",
    ref: String(commentId),
  }),
  review: (prId: PrId, reviewId: number): EffectKey => ({
    prId,
    kind: "review",
    ref: String(reviewId),
  }),
  reviewRequest: (prId: PrId, reviewerGithubId: number, generation: number): EffectKey => ({
    prId,
    kind: "invite",
    ref: `${reviewerGithubId}:${generation}`,
  }),
  reminder: (prId: PrId, reviewerGithubId: number, generation: number): EffectKey => ({
    prId,
    kind: "reminder",
    ref: `${reviewerGithubId}:${generation}`,
  }),
  shipped: (prId: PrId): EffectKey => ({ prId, kind: "shipped", ref: "shipped" }),
} as const;

const section = (text: string): SlackBlock => ({ type: "section", text: { type: "mrkdwn", text } });

const STATE_LABEL: Record<string, string> = {
  approved: "✅ approved",
  changes_requested: "🔄 requested changes",
  commented: "💬 commented",
};

const branches = (pr: PrView) => ({
  base: pr.baseRef ?? "the base branch",
  head: pr.headRef ?? "this branch",
});

export function render(message: Message): RenderedMessage {
  switch (message.kind) {
    case "root": {
      const { pr } = message;
      const { base, head } = branches(pr);
      return {
        text: sanitizeMrkdwn(`PR #${pr.number}: ${pr.title}`),
        blocks: [
          section(
            `🔀 *<${pr.url}|PR #${pr.number}>* — ${sanitizeMrkdwn(pr.title)}\n${sanitizeMrkdwn(pr.authorLogin)} wants to merge into \`${sanitizeInlineCode(base)}\` from \`${sanitizeInlineCode(head)}\``,
          ),
        ],
      };
    }
    case "author_invite":
      return {
        text: sanitizeMrkdwn(`PR opened by ${message.authorLogin}`),
        blocks: [section(`👤 Opened by ${sanitizeMrkdwn(message.authorLabel)}`)],
      };
    case "lifecycle": {
      const { pr } = message;
      return {
        text: sanitizeMrkdwn(`PR #${pr.number} ${message.action}`),
        blocks: [
          section(
            `*<${pr.url}|#${pr.number} ${sanitizeLinkLabel(pr.title)}>* — \`${message.state}\` · by ${sanitizeMrkdwn(pr.authorLogin)}`,
          ),
        ],
      };
    }
    case "review_comment": {
      const location = `${message.path}${message.line ? `:${message.line}` : ""}`;
      const quoted = clipSlackText(githubToMrkdwn(message.body, { quote: true }));
      const by = message.label ? ` · by ${sanitizeMrkdwn(message.label)}` : "";
      return {
        text: sanitizeMrkdwn(`New review comment on ${location}`),
        blocks: [
          section(quoted),
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `<${message.url}|Open> · \`${sanitizeInlineCode(location)}\`${by}`,
              },
            ],
          },
        ],
        images: message.images,
      };
    }
    case "issue_comment": {
      const by = message.label ? ` by ${sanitizeMrkdwn(message.label)}` : "";
      return {
        text: sanitizeMrkdwn(`Comment by ${message.authorLogin}`),
        blocks: [
          section(
            clipSlackText(`💬 <${message.url}|comment>${by}\n${githubToMrkdwn(message.body)}`),
          ),
        ],
        images: message.images,
      };
    }
    case "review": {
      const by = message.label ? ` by ${sanitizeMrkdwn(message.label)}` : "";
      const blocks = [
        section(`<${message.url}|${STATE_LABEL[message.state] ?? message.state}>${by}`),
      ];
      const converted = githubToMrkdwn(message.body);
      if (converted) blocks.push(section(clipSlackText(converted)));
      return {
        text: sanitizeMrkdwn(`Review ${message.state} by ${message.authorLogin}`),
        blocks,
        images: message.images,
      };
    }
    case "review_request":
      return {
        text: sanitizeMrkdwn(`Review requested from ${message.reviewerLogin}`),
        blocks: [
          section(
            message.reviewerLabel === undefined
              ? `👀 Review requested from \`${sanitizeInlineCode(message.reviewerLogin)}\` _(no linked Slack user — /link-github to fix)_`
              : `👀 Review requested from ${sanitizeMrkdwn(message.reviewerLabel)}`,
          ),
        ],
      };
    case "reminder": {
      const mention = message.reviewer ? `<@${message.reviewer}>` : "the requested reviewer";
      return {
        text: "Reminder: this PR is still waiting for review",
        blocks: [
          section(`⏰ ${mention} — this PR has been waiting ~${message.hours}h for your review.`),
        ],
      };
    }
    case "shipped": {
      const { pr } = message;
      const label = sanitizeLinkLabel(`${pr.repo}#${pr.number}`);
      return {
        text: sanitizeMrkdwn(`${pr.repo}#${pr.number} ${pr.title} has shipped`),
        blocks: [
          section(
            `🚢 *<${pr.url}|${label}> ${sanitizeMrkdwn(pr.title)}* has shipped — by ${sanitizeMrkdwn(message.authorLabel)}`,
          ),
        ],
      };
    }
  }
}

const SLACK_TOPIC_MAX = 250;

export function channelTopic(pr: PrView): string {
  const { base, head } = branches(pr);
  const topic = `<${pr.url}|PR ${pr.number}>: ${sanitizeMrkdwn(pr.authorLogin)} wants to merge into ${sanitizeMrkdwn(base)} from ${sanitizeMrkdwn(head)}`;
  return topic.length > SLACK_TOPIC_MAX ? topic.slice(0, SLACK_TOPIC_MAX) : topic;
}
