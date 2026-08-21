import { findMessageEffect } from "../db/repositories/messages.ts";
import { shouldSkipActor } from "../github/actors.ts";
import { reviewCommentBlocks, sanitizeMrkdwn } from "../slack/blocks.ts";
import { RetryableError } from "../worker/retryable.ts";
import { deliverAuthoredMessage, resolveMessageAuthor } from "./authorship.ts";
import { inviteMentionedUsers } from "./mentions.ts";
import {
  type PrHandlerDeps,
  type PullRequestPayload,
  ensurePullRequestChannel,
} from "./pullRequest.ts";

export interface ReviewCommentPayload {
  action: string;
  repository: { full_name: string };
  pull_request: PullRequestPayload["pull_request"];
  comment: {
    id: number;
    commit_id: string;
    path: string;
    line: number | null;
    start_line?: number | null;
    // Present when this comment is a reply within an existing review thread.
    in_reply_to_id?: number | null;
    body: string;
    html_url: string;
    user: { id: number; login: string; type?: string };
  };
}

const REVIEW_COMMENT_KIND = "review_comment";

/**
 * Mirror an inline review comment into the PR channel (U6, R4). Handles the
 * out-of-order case (KTD4): if the comment arrives before the PR's `opened`
 * event, reconcile the channel + root from the comment's embedded pull_request.
 *
 * Threading mirrors GitHub's review threads: a comment that starts a thread is a
 * top-level channel message; a reply (`in_reply_to_id`) is threaded under the
 * Slack message of the comment it replies to. It never threads under the PR root.
 */
export async function handleReviewComment(
  deps: PrHandlerDeps,
  payload: ReviewCommentPayload,
): Promise<void> {
  if (payload.action !== "created") return;
  if (shouldSkipActor(payload.comment.user, deps.allowedBots)) return; // skip non-allowed bots
  // The PR author's inline replies ARE mirrored — replying to review feedback is
  // the core channel conversation.
  const row = await ensurePullRequestChannel(deps, payload.repository, payload.pull_request);
  if (!row.channelId) throw new RetryableError(`PR channel is not ready for ${row.id}`);
  const channelId = row.channelId;

  const c = payload.comment;
  // Link to the comment in the PR discussion (e.g. .../pull/7006#discussion_r…),
  // not the file/line blob view. The file:line still shows as text context.
  const permalink = c.html_url;

  // Author as the commenter: their own token when they've authorized it, else the
  // bot spoofing their name/avatar, else the bot with a plain "by <login>" label.
  const author = await resolveMessageAuthor(deps, c.user);

  // Thread a reply under the Slack message of the comment it replies to; a
  // thread-starting comment posts top-level. THREAD_COMMENTS=false keeps all
  // comments flat (top-level).
  let threadTs: string | undefined;
  if (deps.threadComments !== false && c.in_reply_to_id != null) {
    const parent = await findMessageEffect(deps.db, {
      prId: row.id,
      kind: REVIEW_COMMENT_KIND,
      githubEventRef: String(c.in_reply_to_id),
    });
    threadTs = parent?.slackTs ?? undefined; // parent not mirrored yet -> top-level
  }

  await deliverAuthoredMessage(
    deps,
    { prId: row.id, kind: REVIEW_COMMENT_KIND, githubEventRef: String(c.id) },
    author,
    (mode) => ({
      channel: channelId,
      threadTs,
      // "bot" mode spoofs the linked user's name/avatar (today's behavior); "user"
      // mode posts natively as them, so no spoof is needed.
      username: mode === "bot" ? author.name : undefined,
      iconUrl: mode === "bot" ? author.iconUrl : undefined,
      text: sanitizeMrkdwn(`New review comment on ${c.path}${c.line ? `:${c.line}` : ""}`),
      blocks: reviewCommentBlocks({
        body: c.body,
        permalink,
        path: c.path,
        line: c.line ?? undefined,
        // Only label with the raw login when we have no Slack identity at all.
        authorMention: author.name ? undefined : sanitizeMrkdwn(c.user.login),
      }),
    }),
  );

  // Pull anyone @-mentioned in the comment into the channel (best-effort).
  await inviteMentionedUsers(deps, channelId, c.body);
}
