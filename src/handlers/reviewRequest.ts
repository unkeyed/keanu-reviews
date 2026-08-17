import {
  type GithubEmailFetcher,
  resolveSlackUser,
  reviewerDisplayLabel,
} from "../identity/resolve.ts";
import { sanitizeInlineCode, sanitizeMrkdwn } from "../slack/blocks.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";
import { RetryableError } from "../worker/retryable.ts";
import {
  type PrHandlerDeps,
  type PullRequestPayload,
  ensurePullRequestChannel,
} from "./pullRequest.ts";

export interface ReviewRequestPayload {
  action: "review_requested" | "review_request_removed" | string;
  repository: { full_name: string };
  pull_request: PullRequestPayload["pull_request"];
  requested_reviewer?: { id: number; login: string };
  requested_team?: { id: number; slug: string };
}

export interface ReviewRequestDeps extends PrHandlerDeps {
  fetchGithubEmail?: GithubEmailFetcher;
  /** U8 wires these to schedule / cancel the 12h reminder. */
  onReviewRequested?: (
    prId: string,
    reviewerGithubId: number,
    sourceUpdatedAt?: Date,
    sourceVersion?: string,
  ) => Promise<void>;
  onReviewRequestRemoved?: (
    prId: string,
    reviewerGithubId: number,
    sourceUpdatedAt?: Date,
    sourceVersion?: string,
  ) => Promise<void>;
}

function sourceDate(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Reviewer invitation (U5, R8). Resolves the requested reviewer to a Slack user
 * and invites them; on a miss, posts a plain-login note (graceful degradation).
 * Team requests skip user lookup. Invites are idempotent so a repeat does not
 * double-invite.
 */
export async function handleReviewRequest(
  deps: ReviewRequestDeps,
  payload: ReviewRequestPayload,
  eventRef = payload.pull_request.updated_at,
  sourceVersion = eventRef,
): Promise<void> {
  const { db, slack, logger } = deps;
  const row = await ensurePullRequestChannel(deps, payload.repository, payload.pull_request);
  if (!row.channelId) throw new RetryableError(`PR channel is not ready for ${row.id}`);
  const channelId = row.channelId;

  if (payload.requested_team && !payload.requested_reviewer) {
    logger.info("team review requested; no per-user invite", { team: payload.requested_team.slug });
    return;
  }

  const reviewer = payload.requested_reviewer;
  if (!reviewer) return;

  if (payload.action === "review_request_removed") {
    await deps.onReviewRequestRemoved?.(
      row.id,
      reviewer.id,
      sourceDate(payload.pull_request.updated_at),
      sourceVersion,
    );
    return;
  }

  const effectRef = `${reviewer.id}:${eventRef}`;

  const slackUserId = await resolveSlackUser(deps, {
    githubId: reviewer.id,
    login: reviewer.login,
  });

  if (slackUserId) {
    // The reviewer is added to the channel (which notifies them), so we don't
    // also ping them here — show their Slack display name as plain text.
    const reviewerLabel = await reviewerDisplayLabel(slack, slackUserId, reviewer.login);
    await deliverSlackMessage(
      db,
      slack,
      { prId: row.id, kind: "invite", githubEventRef: effectRef },
      {
        channel: channelId,
        text: sanitizeMrkdwn(`Review requested from ${reviewer.login}`),
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `👀 Review requested from ${reviewerLabel}` },
          },
        ],
      },
      () => slack.inviteUsers(channelId, [slackUserId]),
    );
  } else {
    logger.info("reviewer identity unresolved; posting plain login", { login: reviewer.login });
    await deliverSlackMessage(
      db,
      slack,
      { prId: row.id, kind: "invite", githubEventRef: effectRef },
      {
        channel: channelId,
        text: sanitizeMrkdwn(`Review requested from ${reviewer.login}`),
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `👀 Review requested from \`${sanitizeInlineCode(reviewer.login)}\` _(no linked Slack user — /link-github to fix)_`,
            },
          },
        ],
      },
    );
  }

  await deps.onReviewRequested?.(
    row.id,
    reviewer.id,
    sourceDate(payload.pull_request.updated_at),
    sourceVersion,
  );
}
