import type { ChatPostMessageArguments } from "@slack/web-api";
import type { PrState } from "../domain/prState.ts";
import type { RenderedMessage } from "./gateway.ts";

type ChatPostMessageWithBlocks = Extract<ChatPostMessageArguments, { blocks: unknown[] }>;
export type SlackBlock = ChatPostMessageWithBlocks["blocks"][number];

export type MessageImage =
  | { kind: "embed"; imageUrl: string; sourceUrl: string; alt: string }
  | { kind: "link"; sourceUrl: string; alt: string };

/**
 * Sanitization (U6). Comment bodies are untrusted GitHub
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
 *
 * Anyone can comment on a public PR, so every pattern here and in
 * extractEmbeddedImages must stay linear on a 64 KB body: a scan may not run
 * past the next opener, or a body of repeated unclosed openers rescans the
 * rest of the text from each one.
 */
export function cleanGithubMarkdown(body: string): string {
  return (
    stripHtmlComments(body)
      // The whole `<sup>…</sup>` marketing/footer block (logos, "Fix all" links).
      .replace(/<sup>(?:[^<]|<(?!sup>))*?<\/sup>/gi, "")
      .replace(/!\[[^[\]]*\]\([^()]*\)/g, "")
      // Drop tags but keep their text: <a> wrappers, <picture>/<img> logos.
      .replace(/<\/?[a-zA-Z][^<>]*>/g, "")
      // Non-breaking spaces GitHub emits in footers.
      .replace(/&nbsp;/gi, " ")
      // Collapse the blank space the removals leave behind.
      .replace(/(?<![ \t])[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// Metadata + divider markers GitHub bots hide in HTML comments. No comment can
// close after the last `-->`, so the lazy scan never runs over that tail.
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

/**
 * Extract embedded images from a GitHub comment/review body: markdown
 * `![alt](url)`, HTML `<img src>`, and bare image-file URLs (pasted screenshots
 * GitHub auto-embeds). Only well-formed http(s) URLs are kept — a malformed URL
 * in an image block makes Slack reject the whole message — deduped by URL and
 * capped so a comment can't flood the channel. Callers gate this on non-bot
 * authors so we don't surface bots' deploy-preview/logo images.
 */
export function extractEmbeddedImages(body: string, max = 5): EmbeddedImage[] {
  const out: EmbeddedImage[] = [];
  const seen = new Set<string>();
  const add = (rawUrl: string, alt: string) => {
    const url = rawUrl.trim();
    if (!isHttpUrl(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, alt: alt.trim() || "image" });
  };
  // Markdown images: ![alt](url "optional title") — parsed first so the URL is
  // clean and any alt text is captured before the bare-URL sweep sees it.
  for (const m of body.matchAll(/!\[([^[\]]*)\]\(\s*([^()\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
    add(m[2] ?? "", m[1] ?? "");
  }
  // HTML <img src="…" alt="…">.
  for (const m of body.matchAll(/<img\b[^<>]*?\bsrc=["']([^"']+)["'][^<>]*>/gi)) {
    const alt = /\balt=["']([^"']*)["']/i.exec(m[0]);
    add(m[1] ?? "", alt?.[1] ?? "");
  }
  // Bare image-file URLs. `seen` already holds any markdown/img URLs, so this
  // only adds standalone ones; trailing punctuation is trimmed before matching.
  for (const m of body.matchAll(/https?:\/\/\S+/gi)) {
    const url = (m[0] ?? "").replace(/(?<![)\].,;:!'"])[)\].,;:!'"]+$/, "");
    if (IMAGE_EXT_RE.test(url)) add(url, "");
  }
  return out.slice(0, max);
}

export const SLACK_SECTION_TEXT_LIMIT = 3_000;

/** Apply the limit after every prefix, link, and quote marker is rendered. */
export function clipSlackText(text: string, max = SLACK_SECTION_TEXT_LIMIT): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

/**
 * Every message the bot posts. Labels are raw names; `render` escapes them.
 * Adding a kind means a variant here, a key in `keys`, and a `render` case.
 */
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
      /** "by <label>"; absent when the post already shows who wrote it. */
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
  /** `reviewerLabel` undefined: the reviewer has no linked Slack user. */
  | { kind: "review_request"; reviewerLogin: string; reviewerLabel?: string }
  /** The only message that pings; `reviewer` undefined when unlinked. */
  | { kind: "reminder"; reviewer?: string; hours: number }
  | { kind: "shipped"; pr: PrView; authorLabel: string };

/** `messages.kind` values. Existing rows must keep deduping, so these never change. */
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

/** Durable identity of one Slack effect: one `messages` row. */
export interface EffectKey {
  readonly prId: string;
  readonly kind: LedgerKind;
  readonly ref: string;
}

/** The only place `messages.kind` and ref formats are written. */
export const keys = {
  root: (prId: string): EffectKey => ({ prId, kind: "root", ref: "root" }),
  authorInvite: (prId: string, authorGithubId: number): EffectKey => ({
    prId,
    kind: "author_invite",
    ref: String(authorGithubId),
  }),
  /** `updatedAt` is the payload's `updated_at` string, verbatim. */
  lifecycle: (
    prId: string,
    action: string,
    state: PrState,
    headSha: string,
    updatedAt: string,
  ): EffectKey => ({ prId, kind: "lifecycle", ref: `${action}:${state}:${headSha}:${updatedAt}` }),
  reviewComment: (prId: string, commentId: number): EffectKey => ({
    prId,
    kind: "review_comment",
    ref: String(commentId),
  }),
  issueComment: (prId: string, commentId: number): EffectKey => ({
    prId,
    kind: "issue_comment",
    ref: String(commentId),
  }),
  review: (prId: string, reviewId: number): EffectKey => ({
    prId,
    kind: "review",
    ref: String(reviewId),
  }),
  /** `round` is the reminder generation, or the source version when no reminder row exists. */
  reviewRequest: (prId: string, reviewerGithubId: number, round: number | string): EffectKey => ({
    prId,
    kind: "invite",
    ref: `${reviewerGithubId}:${round}`,
  }),
  reminder: (prId: string, reviewerGithubId: number, generation: number): EffectKey => ({
    prId,
    kind: "reminder",
    ref: `${reviewerGithubId}:${generation}`,
  }),
  shipped: (prId: string): EffectKey => ({ prId, kind: "shipped", ref: "shipped" }),
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
      // Plain text, never an <@id>: the channel invite already notifies them.
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
      // A linked reviewer is invited, which notifies them, so no ping here.
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
      // #shipped is a broadcast channel: the author's name, never a ping.
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

/** Channel topic: `PR 6949: author wants to merge into main from branch`, PR # linked. */
export function channelTopic(pr: PrView): string {
  const { base, head } = branches(pr);
  const topic = `<${pr.url}|PR ${pr.number}>: ${sanitizeMrkdwn(pr.authorLogin)} wants to merge into ${sanitizeMrkdwn(base)} from ${sanitizeMrkdwn(head)}`;
  // The link is at the start, so trimming the tail (branch name) stays safe.
  return topic.length > SLACK_TOPIC_MAX ? topic.slice(0, SLACK_TOPIC_MAX) : topic;
}
