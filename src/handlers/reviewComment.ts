import type { Db } from "../db/client.ts";
import { findByGithubId } from "../db/repositories/identities.ts";
import { buildBlobPermalink } from "../github/permalink.ts";
import type { Logger } from "../logger.ts";
import { reviewCommentBlocks, sanitizeMrkdwn } from "../slack/blocks.ts";
import type { SlackClient } from "../slack/client.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";
import { type PrHandlerDeps, ensurePullRequestChannel } from "./pullRequest.ts";

export interface ReviewCommentPayload {
  action: string;
  repository: { full_name: string };
  pull_request: {
    number: number;
    id: number;
    draft?: boolean;
    merged?: boolean;
    title: string;
    html_url: string;
    user: { login: string };
    head: { sha: string };
  };
  comment: {
    id: number;
    commit_id: string;
    path: string;
    line: number | null;
    start_line?: number | null;
    body: string;
    html_url: string;
    user: { id: number; login: string };
  };
}

export interface ReviewCommentDeps extends PrHandlerDeps {
  db: Db;
  slack: SlackClient;
  logger: Logger;
}

/**
 * Mirror an inline review comment into the PR channel (U6, R4). Handles the
 * out-of-order case (KTD4): if the comment arrives before the PR's `opened`
 * event, reconcile the channel + root from the comment's embedded pull_request.
 */
export async function handleReviewComment(
  deps: ReviewCommentDeps,
  payload: ReviewCommentPayload,
): Promise<void> {
  if (payload.action !== "created") return;
  const row = await ensurePullRequestChannel(deps, payload.repository, payload.pull_request);
  if (!row.channelId) throw new Error(`PR channel is not ready for ${row.id}`);

  const c = payload.comment;
  const permalink = c.line
    ? buildBlobPermalink({
        repoFullName: payload.repository.full_name,
        sha: c.commit_id,
        path: c.path,
        line: c.line,
        startLine: c.start_line ?? null,
      })
    : c.html_url;
  const mapped = await findByGithubId(deps.db, c.user.id);
  const authorMention = mapped ? `<@${mapped.slackUserId}>` : sanitizeMrkdwn(c.user.login);

  await deliverSlackMessage(
    deps.db,
    deps.slack,
    { prId: row.id, kind: "review_comment", githubEventRef: String(c.id) },
    {
      channel: row.channelId,
      text: sanitizeMrkdwn(`New review comment on ${c.path}${c.line ? `:${c.line}` : ""}`),
      threadTs: row.rootMessageTs ?? undefined,
      blocks: reviewCommentBlocks({
        body: c.body,
        permalink,
        path: c.path,
        line: c.line ?? undefined,
        authorMention,
      }),
    },
  );
}
