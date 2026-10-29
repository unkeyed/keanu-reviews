import { findReminderForReviewer } from "../db/repositories/reminders.ts";
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
import { inviteToChannel } from "./invites.ts";
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
  /** Push the reminder window to start when the alert is actually sent. */
  onReviewAlerted?: (prId: string, reviewerGithubId: number) => Promise<void>;
}

function sourceDate(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * How many deliveries to wait for check runs to show up on a commit that
 * currently has none. The worker's first attempt is 1. Attempts below this
 * retry; the attempt that reaches it treats "no check runs at all" as ready.
 * In-progress runs do not use this budget — they wait for `check_run`.
 */
const ABSENT_CI_ATTEMPTS = 4;

export interface ReviewAlertGate {
  /** Job attempt, starting at 1. Omit in direct calls that should not retry. */
  attempt?: number;
  /**
   * A review-request or synchronize event may alert once retries are exhausted
   * and the commit still has no check runs. A `check_run` event must not:
   * an empty list there is lag behind the webhook.
   */
  absentMeansReady?: boolean;
}

interface ReviewerRef {
  id: number;
  login: string;
}

interface AlertSource {
  sourceUpdatedAt: Date;
  sourceVersion: string;
}

/**
 * Reviewer invitation (U5, R8). Resolves the requested reviewer to a Slack user
 * and invites them; on a miss, posts a plain-login note (graceful degradation).
 * Team requests skip user lookup. The Slack message key is stable for one
 * reminder generation, so a later check_run cannot post a second invite.
 */
export async function handleReviewRequest(
  deps: ReviewRequestDeps,
  payload: ReviewRequestPayload,
  eventRef = payload.pull_request.updated_at,
  sourceVersion = eventRef,
  gate: ReviewAlertGate = {},
): Promise<void> {
  const { logger } = deps;
  const row = await ensurePullRequestChannel(deps, payload.repository, payload.pull_request);
  if (!row.channelId) throw new RetryableError(`PR channel is not ready for ${row.id}`);

  if (payload.requested_team && !payload.requested_reviewer) {
    logger.info("team review requested; no per-user invite", { team: payload.requested_team.slug });
    return;
  }

  const reviewer = payload.requested_reviewer;
  if (!reviewer) return;

  const source = alertSource(payload.pull_request.updated_at, sourceVersion);
  if (payload.action === "review_request_removed") {
    await deps.onReviewRequestRemoved?.(
      row.id,
      reviewer.id,
      source.sourceUpdatedAt,
      source.sourceVersion,
    );
    return;
  }

  if (isTerminal(row.currentState)) {
    logger.info("review alert skipped: PR is closed", {
      prId: row.id,
      reviewer: reviewer.login,
      state: row.currentState,
    });
    return;
  }

  // Defer the alert on a draft. ready_for_review (or a later check_run, once
  // the PR is not a draft) sends it. Requesting review before marking ready is
  // common; pulling the reviewer in then is premature.
  if (payload.pull_request.draft || row.currentState === "draft") {
    logger.info("review alert held: PR is still a draft", {
      prId: row.id,
      reviewer: reviewer.login,
    });
    return;
  }

  const ready = await ciAllowsAlert(
    deps,
    { ...row, headSha: payload.pull_request.head.sha },
    { ...gate, absentMeansReady: true },
  );
  if (!ready) {
    // Record the request on the reminder row so a later check_run uses the
    // same Slack idempotency key and a removal can cancel it.
    await recordReviewRequest(deps, row.id, reviewer, source);
    return;
  }

  await sendReviewAlert(deps, row, row.channelId, reviewer, source, true);
}

/**
 * Invite reviewers who were requested while the PR was a draft, once it is
 * marked ready — and only if check runs are passing. Otherwise the reminder
 * row is recorded and `check_run` sends the alert when CI goes green.
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
  if (isTerminal(row.currentState) || row.currentState === "draft") return;

  const source = alertSource(payload.pull_request.updated_at, sourceVersion);
  const viewed = { ...row, headSha: payload.pull_request.head.sha };
  const ready = await ciAllowsAlert(deps, viewed, { ...gate, absentMeansReady: true });
  for (const reviewer of reviewers) {
    if (!ready) {
      await recordReviewRequest(deps, row.id, reviewer, source);
      continue;
    }
    await sendReviewAlert(deps, viewed, row.channelId, reviewer, source, true);
  }
}

/**
 * A new push (`pull_request` / `synchronize`, already subscribed). If this
 * commit has no check runs, `check_run` will never arrive, so this event is
 * what releases a review alert that was waiting on the previous red CI.
 */
export async function handleSynchronizedReviewAlerts(
  deps: ReviewRequestDeps,
  payload: PullRequestPayload,
  eventRef = payload.pull_request.updated_at,
  sourceVersion = eventRef,
  gate: ReviewAlertGate = {},
): Promise<void> {
  if (payload.pull_request.draft) return;
  const reviewers = payload.pull_request.requested_reviewers ?? [];
  if (reviewers.length === 0) return;
  const row = await ensurePullRequestChannel(deps, payload.repository, payload.pull_request);
  if (!row.channelId) throw new RetryableError(`PR channel is not ready for ${row.id}`);
  if (isTerminal(row.currentState) || row.currentState === "draft") return;

  const source = alertSource(payload.pull_request.updated_at, sourceVersion);
  const viewed = { ...row, headSha: payload.pull_request.head.sha };
  const ready = await ciAllowsAlert(deps, viewed, { ...gate, absentMeansReady: true });
  if (!ready) return;
  for (const reviewer of reviewers) {
    await sendReviewAlert(deps, viewed, row.channelId, reviewer, source, false);
  }
}

/**
 * `check_run` completion. Draft comes from the stored PR (and the pull read);
 * CI comes from the check-runs list. Reviewers come from that same pull read.
 * A cancelled reminder (request removed, review submitted, or PR closed) skips
 * the alert. The Slack message key is the reminder generation, so this cannot
 * post a second invite for the same request.
 */
export async function releaseReadyReviewAlerts(
  deps: ReviewRequestDeps,
  row: PullRequestRow,
  gate: ReviewAlertGate = {},
): Promise<void> {
  if (!row.channelId) {
    throw new RetryableError(`PR channel is not ready for ${row.repoFullName}#${row.number}`);
  }
  if (isTerminal(row.currentState) || row.currentState === "draft") return;
  const ready = await ciAllowsAlert(deps, row, gate);
  if (!ready) return;
  if (!deps.fetchPullRequest) return;

  const snapshot = await deps.fetchPullRequest(row.repoFullName, row.number);
  if (!snapshot) {
    throw new RetryableError(`pull request ${row.repoFullName}#${row.number} is not readable yet`);
  }
  if (snapshot.draft) return;

  const source = alertSource(
    row.sourceUpdatedAt?.toISOString() ?? new Date(0).toISOString(),
    "check-run",
  );
  for (const reviewer of snapshot.requestedReviewers ?? []) {
    await sendReviewAlert(deps, row, row.channelId, reviewer, source, false);
  }
}

async function ciAllowsAlert(
  deps: ReviewRequestDeps,
  row: PullRequestRow,
  gate: ReviewAlertGate,
): Promise<boolean> {
  if (!deps.fetchCiReadiness) return true;
  if (!row.headSha) return false;
  const readiness = await deps.fetchCiReadiness(row.repoFullName, row.headSha);
  if (readiness === "passing") return true;
  if (readiness === "failing" || readiness === "pending") {
    deps.logger.info("review alert held: CI is not passing", {
      prId: row.id,
      readiness,
      headSha: row.headSha,
    });
    return false;
  }

  const attempt = gate.attempt;
  const giveUp = attempt === undefined || attempt >= ABSENT_CI_ATTEMPTS;
  if (!giveUp) {
    throw new RetryableError(`CI has not reported yet for ${row.repoFullName}#${row.number}`, {
      headSha: row.headSha,
      attempt,
    });
  }
  if (gate.absentMeansReady) return true;
  deps.logger.info("review alert held: check runs have not registered", {
    prId: row.id,
    headSha: row.headSha,
  });
  return false;
}

/** Remember a requested reviewer without posting, so a later event can alert once. */
async function recordReviewRequest(
  deps: ReviewRequestDeps,
  prId: string,
  reviewer: ReviewerRef,
  source: AlertSource,
): Promise<void> {
  const existing = await findReminderForReviewer(deps.db, prId, reviewer.id);
  if (existing && existing.status !== "cancelled") return;
  await deps.onReviewRequested?.(prId, reviewer.id, source.sourceUpdatedAt, source.sourceVersion);
  deps.logger.info("review alert held until CI passes", { prId, reviewer: reviewer.login });
}

async function sendReviewAlert(
  deps: ReviewRequestDeps,
  row: PullRequestRow,
  channelId: string,
  reviewer: ReviewerRef,
  source: AlertSource,
  revive: boolean,
): Promise<void> {
  let reminder = await findReminderForReviewer(deps.db, row.id, reviewer.id);
  // A review, a removed request, or a closed PR cancels the reminder. Check
  // completion must not bring that back. A new review_requested / ready_for_review
  // can, when its source is newer than the cancellation.
  if (reminder?.status === "cancelled" && !revive) return;
  if (!reminder || reminder.status === "cancelled") {
    await deps.onReviewRequested?.(
      row.id,
      reviewer.id,
      source.sourceUpdatedAt,
      source.sourceVersion,
    );
    reminder = await findReminderForReviewer(deps.db, row.id, reviewer.id);
    if (reminder?.status === "cancelled") return;
  }

  // Generation changes only when a new request replaces a cancelled one, so
  // check_run / synchronize / ready_for_review share one Slack message.
  const effectRef = reminder
    ? `${reviewer.id}:${reminder.generation}`
    : `${reviewer.id}:${source.sourceVersion}`;
  const posted = await inviteReviewer(deps, row.id, channelId, reviewer, effectRef);
  if (posted) await deps.onReviewAlerted?.(row.id, reviewer.id);
}

function alertSource(updatedAt: string, sourceVersion: string): AlertSource {
  return {
    sourceUpdatedAt: sourceDate(updatedAt) ?? new Date(0),
    sourceVersion,
  };
}

/** Resolve a requested reviewer to Slack and post the invite note. */
async function inviteReviewer(
  deps: ReviewRequestDeps,
  prId: string,
  channelId: string,
  reviewer: ReviewerRef,
  effectRef: string,
): Promise<boolean> {
  const { db, slack, logger } = deps;
  const slackUserId = await resolveSlackUser(deps, {
    githubId: reviewer.id,
    login: reviewer.login,
  });

  if (slackUserId) {
    // The reviewer is added to the channel (which notifies them), so we don't
    // also ping them here — show their Slack display name as plain text.
    const reviewerLabel = await reviewerDisplayLabel(slack, slackUserId, reviewer.login);
    const delivered = await deliverSlackMessage(
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
      () => inviteToChannel(deps, channelId, [slackUserId], { prId, role: "reviewer" }),
    );
    return delivered.posted;
  }

  logger.info("reviewer identity unresolved; posting plain login", { login: reviewer.login });
  const delivered = await deliverSlackMessage(
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
  return delivered.posted;
}
