import { type GithubActor, type PullRequestEvent, isTerminal } from "#events";
import type { GithubEmailFetcher } from "#github";
import { displayName, resolveSlackUser } from "#identity";
import { type PrId, Retry } from "#lib";
import { type PrRow, type PrSession, prChannel } from "#pr";
import { findReminderForReviewer } from "#reminders";
import { createLedger, keys } from "#slack";
import type { PrHandlerDeps } from "./deps.ts";

export interface ReviewRequestDeps extends PrHandlerDeps {
  fetchGithubEmail?: GithubEmailFetcher;
  /** U8 wires these to schedule / cancel the 12h reminder. */
  onReviewRequested?: (
    prId: PrId,
    reviewerGithubId: number,
    sourceUpdatedAt?: Date,
    sourceVersion?: string,
  ) => Promise<void>;
  onReviewRequestRemoved?: (
    prId: PrId,
    reviewerGithubId: number,
    sourceUpdatedAt?: Date,
    sourceVersion?: string,
  ) => Promise<void>;
  /** Push the reminder window to start when the alert is actually sent. */
  onReviewAlerted?: (prId: PrId, reviewerGithubId: number) => Promise<void>;
}

export function sourceDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
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
  s: PrSession,
  ev: PullRequestEvent,
  sourceVersion = ev.pr.updatedAt,
  gate: ReviewAlertGate = {},
): Promise<void> {
  const { logger } = deps;
  const row = await s.ready();

  if (ev.requestedTeam && !ev.requestedReviewer) {
    logger.info("team review requested; no per-user invite", { team: ev.requestedTeam });
    return;
  }

  const reviewer = ev.requestedReviewer;
  if (!reviewer) return;

  const source = alertSource(ev.pr.updatedAt, sourceVersion);
  if (ev.action === "review_request_removed") {
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
  if (ev.pr.draft || row.currentState === "draft") {
    logger.info("review alert held: PR is still a draft", {
      prId: row.id,
      reviewer: reviewer.login,
    });
    return;
  }

  const ready = await ciAllowsAlert(
    deps,
    { ...row, headSha: ev.pr.headSha },
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
  s: PrSession,
  ev: PullRequestEvent,
  sourceVersion = ev.pr.updatedAt,
  gate: ReviewAlertGate = {},
): Promise<void> {
  const reviewers = ev.pr.requestedReviewers;
  if (reviewers.length === 0) return;
  const row = await s.ready();
  if (isTerminal(row.currentState) || row.currentState === "draft") return;

  const source = alertSource(ev.pr.updatedAt, sourceVersion);
  const viewed = { ...row, headSha: ev.pr.headSha };
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
  s: PrSession,
  ev: PullRequestEvent,
  sourceVersion = ev.pr.updatedAt,
  gate: ReviewAlertGate = {},
): Promise<void> {
  if (ev.pr.draft) return;
  const reviewers = ev.pr.requestedReviewers;
  if (reviewers.length === 0) return;
  const row = await s.ready();
  if (isTerminal(row.currentState) || row.currentState === "draft") return;

  const source = alertSource(ev.pr.updatedAt, sourceVersion);
  const viewed = { ...row, headSha: ev.pr.headSha };
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
  row: PrRow,
  gate: ReviewAlertGate = {},
): Promise<void> {
  if (!row.channelId) {
    throw new Retry(`PR channel is not ready for ${row.repoFullName}#${row.number}`);
  }
  if (isTerminal(row.currentState) || row.currentState === "draft") return;
  const ready = await ciAllowsAlert(deps, row, gate);
  if (!ready) return;
  if (!deps.fetchPullRequest) return;

  const snapshot = await deps.fetchPullRequest(row.repoFullName, row.number);
  if (!snapshot) {
    throw new Retry(`pull request ${row.repoFullName}#${row.number} is not readable yet`);
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
  row: PrRow,
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
    throw new Retry(`CI has not reported yet for ${row.repoFullName}#${row.number}`, {
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
  prId: PrId,
  reviewer: Pick<GithubActor, "id" | "login">,
  source: AlertSource,
): Promise<void> {
  const existing = await findReminderForReviewer(deps.db, prId, reviewer.id);
  if (existing && existing.status !== "cancelled") return;
  await deps.onReviewRequested?.(prId, reviewer.id, source.sourceUpdatedAt, source.sourceVersion);
  deps.logger.info("review alert held until CI passes", { prId, reviewer: reviewer.login });
}

async function sendReviewAlert(
  deps: ReviewRequestDeps,
  row: PrRow,
  channelId: string,
  reviewer: Pick<GithubActor, "id" | "login">,
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
  const round = reminder ? reminder.generation : source.sourceVersion;
  const posted = await inviteReviewer(deps, row.id, channelId, reviewer, round);
  if (posted) await deps.onReviewAlerted?.(row.id, reviewer.id);
}

function alertSource(updatedAt: string, sourceVersion: string): AlertSource {
  return {
    sourceUpdatedAt: sourceDate(updatedAt) ?? new Date(0),
    sourceVersion,
  };
}

/** Resolve a requested reviewer to Slack and post the invite note. True when it was posted now. */
async function inviteReviewer(
  deps: ReviewRequestDeps,
  prId: PrId,
  channelId: string,
  reviewer: Pick<GithubActor, "id" | "login">,
  round: number | string,
): Promise<boolean> {
  const { db, slack, logger } = deps;
  const channel = prChannel(deps, channelId);
  const delivered = await createLedger(db).deliver(
    keys.reviewRequest(prId, reviewer.id, round),
    channel,
    async () => {
      const slackUserId = await resolveSlackUser(deps, {
        githubId: reviewer.id,
        login: reviewer.login,
      });
      if (!slackUserId) {
        logger.info("reviewer identity unresolved; posting plain login", { login: reviewer.login });
        return { message: { kind: "review_request", reviewerLogin: reviewer.login } };
      }
      return {
        message: {
          kind: "review_request",
          reviewerLogin: reviewer.login,
          reviewerLabel: await displayName(slack, slackUserId, reviewer.login),
        },
        beforePost: () => channel.invite([slackUserId], { prId, role: "reviewer" }),
      };
    },
  );
  return delivered.status === "posted";
}
