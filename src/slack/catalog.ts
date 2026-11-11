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
  return text.length > SLACK_SECTION_TEXT_LIMIT
    ? `${text.slice(0, SLACK_SECTION_TEXT_LIMIT - 1)}…`
    : text;
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
      const quoted = clipSlackText(
        sanitizeMrkdwn(cleanGithubMarkdown(message.body))
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n"),
      );
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
            clipSlackText(
              `💬 <${message.url}|comment>${by}\n${sanitizeMrkdwn(cleanGithubMarkdown(message.body))}`,
            ),
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
      const cleaned = cleanGithubMarkdown(message.body);
      if (cleaned) blocks.push(section(clipSlackText(sanitizeMrkdwn(cleaned))));
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
