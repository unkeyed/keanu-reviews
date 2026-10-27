import {
  cancelReviewAlert,
  holdReviewAlert,
  listHeldReviewAlerts,
  markReviewAlertSent,
} from "../db/repositories/reviewAlerts.ts";
import type { PullRequestRow } from "../db/schema.ts";
import { isTerminal } from "../domain/prState.ts";
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
 * How many deliveries to wait for checks to show up on a commit that currently
 * has none. The worker's first attempt is 1. Attempts below this retry; the
 * attempt that reaches it treats "no CI at all" as ready. In-progress CI does
 * not use this budget — it waits for a completion webhook instead.
 */
const ABSENT_CI_ATTEMPTS = 4;

export interface ReviewAlertGate {
  /** Job attempt, starting at 1. Omit in direct calls that should not retry. */
  attempt?: number;
  /**
   * A review-request event may alert once retries are exhausted and the commit
   * still has no CI. A check event must not: absence there is lag, not "no CI".
   */
  absentMeansReady?: boolean;
}

function effectRefFor(reviewerGithubId: number, sourceVersion: string): string {
  return `${reviewerGithubId}:${sourceVersion}`;
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
  gate: ReviewAlertGate = {},
): Promise<void> {
  const { db, logger } = deps;
  const row = await ensurePullRequestChannel(deps, payload.repository, payload.pull_request);
  if (!row.channelId) throw new RetryableError(`PR channel is not ready for ${row.id}`);

  if (payload.requested_team && !payload.requested_reviewer) {
    logger.info("team review requested; no per-user invite", { team: payload.requested_team.slug });
    return;
  }

  const reviewer = payload.requested_reviewer;
  if (!reviewer) return;

  const sourceUpdatedAt = sourceDate(payload.pull_request.updated_at) ?? new Date(0);
  if (payload.action === "review_request_removed") {
    await cancelReviewAlert(db, {
      prId: row.id,
      reviewerGithubId: reviewer.id,
      reviewerLogin: reviewer.login,
      sourceUpdatedAt,
      sourceVersion,
    });
    await deps.onReviewRequestRemoved?.(row.id, reviewer.id, sourceUpdatedAt, sourceVersion);
    return;
  }

  await holdReviewAlert(db, {
    prId: row.id,
    reviewerGithubId: reviewer.id,
    reviewerLogin: reviewer.login,
    effectRef: effectRefFor(reviewer.id, sourceVersion),
    sourceUpdatedAt,
    sourceVersion,
  });

  // Defer inviting reviewers on a draft PR. Requesting review before marking a PR
  // ready is common (assign reviewers, keep drafting); pulling them into the
  // channel then is premature. handleReadyForReview invites whoever is still
  // requested once the PR is marked ready — and only if CI is passing.
  if (payload.pull_request.draft || row.currentState === "draft") {
    logger.info("review alert held: PR is still a draft", {
      prId: row.id,
      reviewer: reviewer.login,
    });
    return;
  }

  await releaseReadyReviewAlerts(
    deps,
    { ...row, currentState: "pr", headSha: payload.pull_request.head.sha },
    { ...gate, absentMeansReady: true },
  );
}

/**
 * Invite the reviewers still requested when a draft PR is marked ready for
 * review (U5). Reviewers assigned while it was a draft were deferred. CI still
 * has to be passing; otherwise the alert stays held until checks go green.
 */
export async function handleReadyForReview(
  deps: ReviewRequestDeps,
  payload: PullRequestPayload,
  eventRef = payload.pull_request.updated_at,
  sourceVersion = eventRef,
  gate: ReviewAlertGate = {},
): Promise<void> {
  const reviewers = payload.pull_request.requested_reviewers ?? [];
  if (reviewers.length === 0) return;
  const row = await ensurePullRequestChannel(deps, payload.repository, payload.pull_request);
  if (!row.channelId) throw new RetryableError(`PR channel is not ready for ${row.id}`);

  const sourceUpdatedAt = sourceDate(payload.pull_request.updated_at) ?? new Date(0);
  for (const reviewer of reviewers) {
    await holdReviewAlert(deps.db, {
      prId: row.id,
      reviewerGithubId: reviewer.id,
      reviewerLogin: reviewer.login,
      effectRef: effectRefFor(reviewer.id, sourceVersion),
      sourceUpdatedAt,
      sourceVersion,
    });
  }

  // This action is the draft → ready transition, even if the stored row has
  // not caught up yet. CI is evaluated against the head SHA on the event.
  await releaseReadyReviewAlerts(
    deps,
    { ...row, currentState: "pr", headSha: payload.pull_request.head.sha },
    { ...gate, absentMeansReady: true },
  );
}

/**
 * Send held review-needed alerts once the PR is not a draft and CI is passing.
 * Check completion, a legacy commit status, and ready_for_review all land here.
 * Already-sent alerts are left alone, so the failing → passing transition
 * notifies each reviewer once.
 */
export async function releaseReadyReviewAlerts(
  deps: ReviewRequestDeps,
  row: PullRequestRow,
  gate: ReviewAlertGate = {},
): Promise<void> {
  if (!row.channelId) {
    throw new RetryableError(`PR channel is not ready for ${row.repoFullName}#${row.number}`);
  }
  if (isTerminal(row.currentState)) return;

  const held = await listHeldReviewAlerts(deps.db, row.id);
  if (held.length === 0) return;
  if (row.currentState === "draft") {
    deps.logger.info("review alert held: PR is still a draft", { prId: row.id });
    return;
  }

  const readiness = await ciReadinessForAlert(deps, row, gate);
  if (readiness !== "ready") {
    deps.logger.info("review alert held: CI is not passing", {
      prId: row.id,
      readiness,
      headSha: row.headSha,
    });
    return;
  }

  for (const alert of held) {
    await inviteReviewer(
      deps,
      row.id,
      row.channelId,
      { id: alert.reviewerGithubId, login: alert.reviewerLogin },
      alert.effectRef,
      { sourceUpdatedAt: alert.sourceUpdatedAt, sourceVersion: alert.sourceVersion },
    );
    await markReviewAlertSent(deps.db, alert.id);
  }
}

async function ciReadinessForAlert(
  deps: ReviewRequestDeps,
  row: PullRequestRow,
  gate: ReviewAlertGate,
): Promise<"ready" | "failing" | "pending"> {
  if (!deps.fetchCiReadiness) return "ready";
  if (!row.headSha) return "pending";
  const readiness = await deps.fetchCiReadiness(row.repoFullName, row.headSha);
  if (readiness === "passing") return "ready";
  if (readiness === "failing" || readiness === "pending") return readiness;

  const attempt = gate.attempt;
  const giveUp = attempt === undefined || attempt >= ABSENT_CI_ATTEMPTS;
  if (!giveUp) {
    throw new RetryableError(`CI has not reported yet for ${row.repoFullName}#${row.number}`, {
      headSha: row.headSha,
      attempt,
    });
  }
  // No checks registered. Review requests treat that as "this repo has no CI"
  // so reviewers are not stuck forever. A check event must not: an empty list
  // there is lag behind the webhook, and the request path owns the no-CI case.
  return gate.absentMeansReady ? "ready" : "pending";
}

/** Resolve a requested reviewer to Slack, post the invite note, and schedule the reminder. */
async function inviteReviewer(
  deps: ReviewRequestDeps,
  prId: string,
  channelId: string,
  reviewer: { id: number; login: string },
  effectRef: string,
  source: { sourceUpdatedAt?: Date; sourceVersion: string },
): Promise<void> {
  const { db, slack, logger } = deps;
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
      { prId, kind: "invite", githubEventRef: effectRef },
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
      { prId, kind: "invite", githubEventRef: effectRef },
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

  await deps.onReviewRequested?.(prId, reviewer.id, source.sourceUpdatedAt, source.sourceVersion);
}
