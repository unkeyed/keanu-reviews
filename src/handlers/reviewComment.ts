import { findMessageEffect } from "../db/repositories/messages.ts";
import { shouldSkipActor } from "../github/actors.ts";
import { resolveSlackUser } from "../identity/resolve.ts";
import { reviewCommentBlocks, sanitizeMrkdwn } from "../slack/blocks.ts";
import type { SlackMessage } from "../slack/client.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";
import { RetryableError } from "../worker/retryable.ts";
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

  const c = payload.comment;
  // Link to the comment in the PR discussion (e.g. .../pull/7006#discussion_r…),
  // not the file/line blob view. The file:line still shows as text context.
  const permalink = c.html_url;

  // Author the message as the commenter's linked Slack user (name + avatar) when
  // we can; then the "· by …" label is redundant and is omitted. Fall back to
  // bot authorship + a plain "by <login>" label for unlinked users and bots.
  const authorship = await resolveCommentAuthor(deps, c.user);

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

  await deliverSlackMessage(
    deps.db,
    deps.slack,
    { prId: row.id, kind: REVIEW_COMMENT_KIND, githubEventRef: String(c.id) },
    {
      channel: row.channelId,
      threadTs,
      username: authorship.username,
      iconUrl: authorship.iconUrl,
      text: sanitizeMrkdwn(`New review comment on ${c.path}${c.line ? `:${c.line}` : ""}`),
      blocks: reviewCommentBlocks({
        body: c.body,
        permalink,
        path: c.path,
        line: c.line ?? undefined,
        authorMention: authorship.authorMention,
      }),
    },
  );
}

/**
 * Decide how to attribute a mirrored comment: as the linked Slack user when we
 * can resolve their profile (username + avatar, no in-body label), otherwise as
 * the bot with a plain "by <login>" label.
 */
export async function resolveCommentAuthor(
  deps: PrHandlerDeps,
  user: { id: number; login: string },
): Promise<Pick<SlackMessage, "username" | "iconUrl"> & { authorMention?: string }> {
  const slackUserId = await resolveSlackUser(deps, { githubId: user.id, login: user.login });
  const profile = slackUserId ? await deps.slack.lookupUserProfile(slackUserId) : undefined;
  if (profile?.name) {
    return { username: profile.name, iconUrl: profile.iconUrl };
  }
  return { authorMention: sanitizeMrkdwn(user.login) };
}
