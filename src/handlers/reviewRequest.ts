import { type GithubEmailFetcher, resolveSlackUser } from "../identity/resolve.ts";
import { sanitizeInlineCode, sanitizeMrkdwn } from "../slack/blocks.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";
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
  onReviewRequested?: (prId: string, reviewerGithubId: number) => Promise<void>;
  onReviewRequestRemoved?: (prId: string, reviewerGithubId: number) => Promise<void>;
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
): Promise<void> {
  const { db, slack, logger } = deps;
  const row = await ensurePullRequestChannel(deps, payload.repository, payload.pull_request);
  if (!row.channelId) throw new Error(`PR channel is not ready for ${row.id}`);
  const channelId = row.channelId;

  if (payload.requested_team && !payload.requested_reviewer) {
    logger.info("team review requested; no per-user invite", { team: payload.requested_team.slug });
    return;
  }

  const reviewer = payload.requested_reviewer;
  if (!reviewer) return;

  if (payload.action === "review_request_removed") {
    await deps.onReviewRequestRemoved?.(row.id, reviewer.id);
    return;
  }

  const slackUserId = await resolveSlackUser(deps, {
    githubId: reviewer.id,
    login: reviewer.login,
  });

  if (slackUserId) {
    await deliverSlackMessage(
      db,
      slack,
      { prId: row.id, kind: "invite", githubEventRef: String(reviewer.id) },
      {
        channel: channelId,
        text: sanitizeMrkdwn(`Review requested from ${reviewer.login}`),
        threadTs: row.rootMessageTs ?? undefined,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `👀 Review requested from <@${slackUserId}>` },
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
      { prId: row.id, kind: "invite", githubEventRef: String(reviewer.id) },
      {
        channel: channelId,
        text: sanitizeMrkdwn(`Review requested from ${reviewer.login}`),
        threadTs: row.rootMessageTs ?? undefined,
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

  await deps.onReviewRequested?.(row.id, reviewer.id);
}
