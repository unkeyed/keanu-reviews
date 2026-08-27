import { findMessageEffect } from "../db/repositories/messages.ts";
import { findByRepoNumber } from "../db/repositories/pullRequests.ts";
import { isBotActor, shouldSkipActor } from "../github/actors.ts";
import { resolveEmbeddedImages } from "../github/attachments.ts";
import { reviewerDisplayLabel } from "../identity/resolve.ts";
import {
  cleanGithubMarkdown,
  extractEmbeddedImages,
  imageBlocks,
  issueCommentBlocks,
  reviewSummaryBlocks,
  sanitizeMrkdwn,
} from "../slack/blocks.ts";
import type { SlackMessage } from "../slack/client.ts";
import { RetryableError } from "../worker/retryable.ts";
import {
  deleteMirroredComment,
  deliverAuthoredMessage,
  resolveMessageAuthor,
  updateAuthoredMessage,
} from "./authorship.ts";
import { inviteMentionedUsers } from "./mentions.ts";
import { reportMergeability } from "./mergeability.ts";
import {
  type PrHandlerDeps,
  type PullRequestPayload,
  ensurePullRequestChannel,
} from "./pullRequest.ts";

export interface ReviewDeps extends PrHandlerDeps {
  /** U8 wires this to cancel a reviewer's pending reminder once they review. */
  onReviewSubmitted?: (
    prId: string,
    reviewerGithubId: number,
    sourceUpdatedAt?: Date,
    sourceVersion?: string,
  ) => Promise<void>;
}

export interface ReviewPayload {
  action: string;
  repository: { full_name: string };
  pull_request: PullRequestPayload["pull_request"];
  review: {
    id: number;
    state: string; // approved | changes_requested | commented
    body: string | null;
    html_url: string;
    submitted_at?: string;
    user: { id: number; login: string; type?: string };
  };
}

function sourceDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Mirror a review submission (U6, R5) and cancel the reviewer's reminder (U8 hook). */
export async function handleReview(
  deps: ReviewDeps,
  payload: ReviewPayload,
  sourceVersion = String(payload.review.id),
): Promise<void> {
  if (payload.action !== "submitted") return;
  if (shouldSkipActor(payload.review.user, deps.allowedBots)) return; // skip non-allowed bots
  const row = await ensurePullRequestChannel(deps, payload.repository, payload.pull_request);
  if (!row.channelId) throw new RetryableError(`PR channel is not ready for ${row.id}`);
  const channelId = row.channelId;

  const r = payload.review;
  // GitHub is the source of truth: cancel before enrichment or Slack delivery,
  // so a downstream failure cannot leave an obsolete reminder live.
  await deps.onReviewSubmitted?.(
    row.id,
    r.user.id,
    sourceDate(r.submitted_at ?? payload.pull_request.updated_at),
    sourceVersion,
  );
  const author = await resolveMessageAuthor(deps, r.user);
  // A "commented" review whose body is empty after cleaning is just the wrapper
  // GitHub emits around inline review comments — the real content arrives as
  // review_comment events. Posting it would be an empty "💬 commented by …" line,
  // so skip the message (but still cancel the reminder above and report
  // mergeability below).
  const isEmptyCommentWrapper = r.state === "commented" && !cleanGithubMarkdown(r.body ?? "");
  if (!isEmptyCommentWrapper) {
    // Never ping the reviewer for their own review activity (approve, request
    // changes, comment) — show their Slack display name as plain text instead.
    const authorLabel = await reviewerDisplayLabel(deps.slack, author.slackUserId, r.user.login);
    // Embed images from human reviews only (resolved to a Slack-renderable URL).
    const images = isBotActor(r.user)
      ? []
      : await resolveEmbeddedImages(extractEmbeddedImages(r.body ?? ""));
    await deliverAuthoredMessage(
      deps,
      { prId: row.id, kind: "review", githubEventRef: String(r.id) },
      author,
      (mode) => ({
        channel: channelId,
        // Thread bot reviews under the PR root to keep the channel readable.
        threadTs: isBotActor(r.user) ? (row.rootMessageTs ?? undefined) : undefined,
        text: sanitizeMrkdwn(`Review ${r.state} by ${r.user.login}`),
        blocks: [
          ...reviewSummaryBlocks({
            state: r.state,
            body: r.body ?? "",
            htmlUrl: r.html_url,
            // Reviews never spoof name/avatar: "user" mode posts natively as them
            // (no label); otherwise show the plain-text display-name label.
            authorMention: mode === "user" ? undefined : authorLabel,
          }),
          ...imageBlocks(images),
        ],
      }),
    );
  }

  // Pull anyone @-mentioned in the review body into the channel (best-effort).
  // The PR author is skipped — already a member of their own channel.
  await inviteMentionedUsers(deps, channelId, r.body ?? "", payload.pull_request.user.login);

  // A submitted review can flip mergeability (e.g. required approval satisfied).
  await reportMergeability(deps, row, `review:${r.id}`);
}

export interface IssueCommentPayload {
  action: string;
  repository: { full_name: string };
  // `issue.user` is the PR opener (issues and PRs share the same payload shape).
  issue: { number: number; pull_request?: unknown; user?: { login: string } };
  comment: {
    id: number;
    body: string;
    html_url: string;
    user: { id: number; login: string; type?: string };
  };
}

/** Mirror a PR conversation comment (U6). Ignored for non-PR issues. */
export async function handleIssueComment(
  deps: ReviewDeps,
  payload: IssueCommentPayload,
): Promise<void> {
  // `created` mirrors, `edited` syncs the body, `deleted` removes the mirror;
  // other actions are ignored.
  if (!["created", "edited", "deleted"].includes(payload.action)) return;
  if (!payload.issue.pull_request) return; // not a PR — ignore
  // Skip bot comments (Vercel/Mintlify deploy previews, our own merge comment, …)
  // unless allow-listed. `type: "Bot"` covers our App's bot, so this also guards
  // against echoing our own merge comment (never allow-list our App's login).
  if (shouldSkipActor(payload.comment.user, deps.allowedBots)) return;

  // A deletion removes the mirror without ever creating a channel.
  if (payload.action === "deleted") {
    await deleteMirroredComment(deps, {
      repoFullName: payload.repository.full_name,
      number: payload.issue.number,
      kind: "issue_comment",
      commentId: payload.comment.id,
      user: payload.comment.user,
    });
    return;
  }

  const row = await findByRepoNumber(deps.db, payload.repository.full_name, payload.issue.number);
  if (!row?.channelId) {
    throw new RetryableError(
      `PR channel is not ready for ${payload.repository.full_name}#${payload.issue.number}`,
    );
  }
  const channelId = row.channelId;

  const c = payload.comment;
  // Author as the commenter: their own token when authorized, else the bot
  // spoofing their name/avatar, else the bot with a plain "by <login>" label. PR
  // conversation comments aren't threaded on GitHub, so they post top-level.
  const author = await resolveMessageAuthor(deps, c.user);
  // Embed images from human comments only (resolved to a Slack-renderable URL).
  const images = isBotActor(c.user)
    ? []
    : await resolveEmbeddedImages(extractEmbeddedImages(c.body));
  const effect = { prId: row.id, kind: "issue_comment", githubEventRef: String(c.id) };
  const render = (mode: "user" | "bot"): SlackMessage => ({
    channel: channelId,
    username: mode === "bot" ? author.name : undefined,
    iconUrl: mode === "bot" ? author.iconUrl : undefined,
    text: sanitizeMrkdwn(`Comment by ${c.user.login}`),
    blocks: [
      ...issueCommentBlocks({
        body: c.body,
        htmlUrl: c.html_url,
        authorMention: author.name ? undefined : sanitizeMrkdwn(c.user.login),
      }),
      ...imageBlocks(images),
    ],
  });

  // An edit updates the mirrored message in place; otherwise post it.
  const existing =
    payload.action === "edited" ? await findMessageEffect(deps.db, effect) : undefined;
  if (existing?.status === "sent" && existing.slackTs) {
    await updateAuthoredMessage(deps, existing.slackTs, channelId, author, render);
  } else {
    await deliverAuthoredMessage(deps, effect, author, render);
  }

  // Pull anyone @-mentioned in the comment into the channel (best-effort). Runs
  // on edits too, so a newly added mention still pulls that person in. The PR
  // author is skipped — already a member of their own channel.
  await inviteMentionedUsers(deps, channelId, c.body, payload.issue.user?.login);
}
