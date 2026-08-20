import { isBotActor, shouldSkipActor } from "../github/actors.ts";
import { resolveSlackUser, reviewerDisplayLabel } from "../identity/resolve.ts";
import { reviewCommentBlocks, sanitizeMrkdwn } from "../slack/blocks.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";
import { RetryableError } from "../worker/retryable.ts";
import {
  type PrHandlerDeps,
  type PullRequestPayload,
  commentThreadTs,
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
    body: string;
    html_url: string;
    user: { id: number; login: string; type?: string };
  };
}

/**
 * Mirror an inline review comment into the PR channel (U6, R4). Handles the
 * out-of-order case (KTD4): if the comment arrives before the PR's `opened`
 * event, reconcile the channel + root from the comment's embedded pull_request.
 */
export async function handleReviewComment(
  deps: PrHandlerDeps,
  payload: ReviewCommentPayload,
): Promise<void> {
  if (payload.action !== "created") return;
  if (shouldSkipActor(payload.comment.user, deps.allowedBots)) return; // skip non-allowed bots
  // The PR author's inline replies ARE mirrored — replying to review feedback is
  // the core channel conversation (previously these were dropped, which left only
  // an empty "commented by …" wrapper in Slack).
  const row = await ensurePullRequestChannel(deps, payload.repository, payload.pull_request);
  if (!row.channelId) throw new RetryableError(`PR channel is not ready for ${row.id}`);

  const c = payload.comment;
  // Link to the comment in the PR discussion (e.g. .../pull/7006#discussion_r…),
  // not the file/line blob view. The file:line still shows as text context.
  const permalink = c.html_url;
  // Attribute the reply to the commenter's Slack display name (no @-ping), not
  // their raw GitHub login, so it reads as coming from the Slack user.
  const slackUserId = await resolveSlackUser(deps, { githubId: c.user.id, login: c.user.login });
  const commenter = await reviewerDisplayLabel(deps.slack, slackUserId, c.user.login);

  await deliverSlackMessage(
    deps.db,
    deps.slack,
    { prId: row.id, kind: "review_comment", githubEventRef: String(c.id) },
    {
      channel: row.channelId,
      // Thread the reply under the PR root (bots always; humans per THREAD_COMMENTS).
      threadTs: commentThreadTs(deps, isBotActor(c.user), row.rootMessageTs),
      text: sanitizeMrkdwn(`New review comment on ${c.path}${c.line ? `:${c.line}` : ""}`),
      blocks: reviewCommentBlocks({
        body: c.body,
        permalink,
        path: c.path,
        line: c.line ?? undefined,
        authorMention: commenter,
      }),
    },
  );
}
