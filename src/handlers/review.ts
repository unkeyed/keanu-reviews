import type { Db } from "../db/client.ts";
import { findByGithubId } from "../db/repositories/identities.ts";
import { findByRepoNumber } from "../db/repositories/pullRequests.ts";
import type { Logger } from "../logger.ts";
import { issueCommentBlocks, reviewSummaryBlocks, sanitizeMrkdwn } from "../slack/blocks.ts";
import type { SlackClient } from "../slack/client.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";
import { type PullRequestPayload, ensurePullRequestChannel } from "./pullRequest.ts";

export interface ReviewDeps {
  db: Db;
  slack: SlackClient;
  logger: Logger;
  /** U8 wires this to cancel a reviewer's pending reminder once they review. */
  onReviewSubmitted?: (prId: string, reviewerGithubId: number) => Promise<void>;
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
    user: { id: number; login: string };
  };
}

/** Mirror a review submission (U6, R5) and cancel the reviewer's reminder (U8 hook). */
export async function handleReview(deps: ReviewDeps, payload: ReviewPayload): Promise<void> {
  if (payload.action !== "submitted") return;
  const row = await ensurePullRequestChannel(deps, payload.repository, payload.pull_request);
  if (!row.channelId) throw new Error(`PR channel is not ready for ${row.id}`);

  const r = payload.review;
  const mapped = await findByGithubId(deps.db, r.user.id);
  await deliverSlackMessage(
    deps.db,
    deps.slack,
    { prId: row.id, kind: "review", githubEventRef: String(r.id) },
    {
      channel: row.channelId,
      text: sanitizeMrkdwn(`Review ${r.state} by ${r.user.login}`),
      threadTs: row.rootMessageTs ?? undefined,
      blocks: reviewSummaryBlocks({
        state: r.state,
        body: r.body ?? "",
        htmlUrl: r.html_url,
        authorMention: mapped ? `<@${mapped.slackUserId}>` : sanitizeMrkdwn(r.user.login),
      }),
    },
  );

  await deps.onReviewSubmitted?.(row.id, r.user.id);
}

export interface IssueCommentPayload {
  action: string;
  repository: { full_name: string };
  issue: { number: number; pull_request?: unknown };
  comment: { id: number; body: string; html_url: string; user: { id: number; login: string } };
}

/** Mirror a PR conversation comment (U6). Ignored for non-PR issues. */
export async function handleIssueComment(
  deps: ReviewDeps,
  payload: IssueCommentPayload,
): Promise<void> {
  if (payload.action !== "created") return;
  if (!payload.issue.pull_request) return; // not a PR — ignore
  const row = await findByRepoNumber(deps.db, payload.repository.full_name, payload.issue.number);
  if (!row?.channelId) {
    throw new Error(
      `PR channel is not ready for ${payload.repository.full_name}#${payload.issue.number}`,
    );
  }

  const c = payload.comment;
  const mapped = await findByGithubId(deps.db, c.user.id);
  const authorMention = mapped ? `<@${mapped.slackUserId}>` : sanitizeMrkdwn(c.user.login);
  await deliverSlackMessage(
    deps.db,
    deps.slack,
    { prId: row.id, kind: "issue_comment", githubEventRef: String(c.id) },
    {
      channel: row.channelId,
      text: sanitizeMrkdwn(`Comment by ${c.user.login}`),
      threadTs: row.rootMessageTs ?? undefined,
      blocks: issueCommentBlocks({
        body: c.body,
        htmlUrl: c.html_url,
        authorMention,
      }),
    },
  );
}
