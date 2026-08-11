import type { Db } from "../db/client.ts";
import { recordMessage } from "../db/repositories/messages.ts";
import { findByRepoNumber } from "../db/repositories/pullRequests.ts";
import { type GithubEmailFetcher, resolveSlackUser } from "../identity/resolve.ts";
import type { Logger } from "../logger.ts";
import type { SlackClient } from "../slack/client.ts";

export interface ReviewRequestPayload {
  action: "review_requested" | "review_request_removed" | string;
  repository: { full_name: string };
  pull_request: { number: number };
  requested_reviewer?: { id: number; login: string };
  requested_team?: { id: number; slug: string };
}

export interface ReviewRequestDeps {
  db: Db;
  slack: SlackClient;
  logger: Logger;
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
  const row = await findByRepoNumber(db, payload.repository.full_name, payload.pull_request.number);
  if (!row?.channelId) {
    logger.warn("review request for PR with no channel yet", {
      repo: payload.repository.full_name,
      number: payload.pull_request.number,
    });
    return;
  }

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

  // Idempotent invite: record first; a repeat returns false and short-circuits.
  const firstTime = await recordMessage(db, {
    prId: row.id,
    kind: "invite",
    githubEventRef: String(reviewer.id),
    slackTs: "-",
  });

  const slackUserId = await resolveSlackUser(deps, {
    githubId: reviewer.id,
    login: reviewer.login,
  });

  if (firstTime) {
    if (slackUserId) {
      await slack.inviteUsers(row.channelId, [slackUserId]);
      await slack.postMessage({
        channel: row.channelId,
        text: `Review requested from ${reviewer.login}`,
        threadTs: row.rootMessageTs ?? undefined,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `👀 Review requested from <@${slackUserId}>` },
          },
        ],
      });
    } else {
      logger.info("reviewer identity unresolved; posting plain login", { login: reviewer.login });
      await slack.postMessage({
        channel: row.channelId,
        text: `Review requested from ${reviewer.login}`,
        threadTs: row.rootMessageTs ?? undefined,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `👀 Review requested from \`${reviewer.login}\` _(no linked Slack user — /link-github to fix)_`,
            },
          },
        ],
      });
    }
  }

  await deps.onReviewRequested?.(row.id, reviewer.id);
}
