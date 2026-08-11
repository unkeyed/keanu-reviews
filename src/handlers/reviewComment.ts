import type { Db } from "../db/client.ts";
import { findByGithubId } from "../db/repositories/identities.ts";
import { recordMessage } from "../db/repositories/messages.ts";
import { findByRepoNumber } from "../db/repositories/pullRequests.ts";
import { buildBlobPermalink } from "../github/permalink.ts";
import type { Logger } from "../logger.ts";
import { reviewCommentBlocks } from "../slack/blocks.ts";
import type { SlackClient } from "../slack/client.ts";
import { type PrHandlerDeps, type PullRequestPayload, handlePullRequest } from "./pullRequest.ts";

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
  const row = await ensureChannel(deps, payload);
  if (!row?.channelId) return;

  const c = payload.comment;
  // Idempotent: record before posting; a replay returns false and short-circuits.
  const firstTime = await recordMessage(deps.db, {
    prId: row.id,
    kind: "review_comment",
    githubEventRef: String(c.id),
    slackTs: "-",
  });
  if (!firstTime) return;

  const permalink = buildBlobPermalink({
    repoFullName: payload.repository.full_name,
    sha: c.commit_id,
    path: c.path,
    line: c.line ?? 1,
    startLine: c.start_line ?? null,
  });
  const mapped = await findByGithubId(deps.db, c.user.id);
  const authorMention = mapped ? `<@${mapped.slackUserId}>` : c.user.login;

  await deps.slack.postMessage({
    channel: row.channelId,
    text: `New review comment on ${c.path}:${c.line ?? 1}`,
    threadTs: row.rootMessageTs ?? undefined,
    blocks: reviewCommentBlocks({
      body: c.body,
      permalink,
      path: c.path,
      line: c.line ?? 1,
      authorMention,
    }),
  });
}

async function ensureChannel(deps: ReviewCommentDeps, payload: ReviewCommentPayload) {
  let row = await findByRepoNumber(
    deps.db,
    payload.repository.full_name,
    payload.pull_request.number,
  );
  if (!row?.channelId) {
    // Reconcile lazily from the child payload (out-of-order safeguard).
    const synthesized: PullRequestPayload = {
      action: "synchronize",
      repository: payload.repository,
      pull_request: payload.pull_request,
    };
    await handlePullRequest(deps, synthesized);
    row = await findByRepoNumber(
      deps.db,
      payload.repository.full_name,
      payload.pull_request.number,
    );
  }
  return row;
}
