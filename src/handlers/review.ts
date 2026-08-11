import { findByRepoNumber } from "../db/repositories/pullRequests.ts";
import { resolveSlackUser } from "../identity/resolve.ts";
import { issueCommentBlocks, reviewSummaryBlocks, sanitizeMrkdwn } from "../slack/blocks.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";
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
    user: { id: number; login: string };
  };
}

function sourceDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Mirror a review submission (U6, R5) and cancel the reviewer's reminder (U8 hook). */
export async function handleReview(deps: ReviewDeps, payload: ReviewPayload): Promise<void> {
  if (payload.action !== "submitted") return;
  const row = await ensurePullRequestChannel(deps, payload.repository, payload.pull_request);
  if (!row.channelId) throw new Error(`PR channel is not ready for ${row.id}`);

  const r = payload.review;
  // GitHub is the source of truth: cancel before enrichment or Slack delivery,
  // so a downstream failure cannot leave an obsolete reminder live.
  await deps.onReviewSubmitted?.(
    row.id,
    r.user.id,
    sourceDate(r.submitted_at ?? payload.pull_request.updated_at),
  );
  const slackUserId = await resolveSlackUser(
    { db: deps.db, slack: deps.slack },
    { githubId: r.user.id, login: r.user.login },
  );
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
        authorMention: slackUserId ? `<@${slackUserId}>` : sanitizeMrkdwn(r.user.login),
      }),
    },
  );
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
  const slackUserId = await resolveSlackUser(
    { db: deps.db, slack: deps.slack },
    { githubId: c.user.id, login: c.user.login },
  );
  const authorMention = slackUserId ? `<@${slackUserId}>` : sanitizeMrkdwn(c.user.login);
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
