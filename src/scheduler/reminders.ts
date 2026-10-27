import type { Db } from "../db/client.ts";
import { findByGithubId } from "../db/repositories/identities.ts";
import { findById } from "../db/repositories/pullRequests.ts";
import {
  cancelForReviewer,
  cancelReminderClaim,
  claimReminder,
  isReminderClaimCurrent,
  listDue,
  markReminderSent,
  rescheduleOrFailReminder,
  scheduleReminder,
} from "../db/repositories/reminders.ts";
import type { PullRequestRow } from "../db/schema.ts";
import { isTerminal } from "../domain/prState.ts";
import type { CiReadinessFetcher } from "../github/users.ts";
import type { ReviewApprovalFetcher } from "../github/users.ts";
import type { PullRequestFetcher } from "../handlers/mergeability.ts";
import type { Logger } from "../logger.ts";
import type { SlackClient } from "../slack/client.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";
import { type ReminderWindow, isWithinWindow } from "./window.ts";

/** `mergeable_state` values that mean the PR is ready to merge. */
const READY_TO_MERGE_STATES = new Set(["clean", "has_hooks"]);
/**
 * Approval count that stops reminders when `suppressApprovals` is omitted.
 * Production sets that from `REMINDER_SUPPRESS_APPROVALS` (default 1).
 */
const DEFAULT_SUPPRESS_APPROVALS = 1;

export interface ReminderDeps {
  db: Db;
  slack: SlackClient;
  logger: Logger;
  reminderHours: number;
  reminderLeaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  batchSize?: number;
  now?: () => number;
  /** Only deliver reminders during this daily window; omit to deliver anytime. */
  deliveryWindow?: ReminderWindow;
  /** Suppress reminders once the PR is ready to merge (mergeable_state clean). */
  fetchPullRequest?: PullRequestFetcher;
  /**
   * Hold a due reminder while CI is failing or still running. Absent CI (no
   * checks configured) does not hold it — the initial alert already waited for
   * checks to appear. Omit to deliver without consulting CI.
   */
  fetchCiReadiness?: CiReadinessFetcher;
  /**
   * Suppress every pending reminder for a PR once it has at least this many
   * approvals. Defaults to 1 (`REMINDER_SUPPRESS_APPROVALS`).
   */
  suppressApprovals?: number;
  /** Suppress reminders once the PR already has enough approvals. */
  fetchApprovalCount?: ReviewApprovalFetcher;
}

/**
 * Whether a PR no longer needs review reminders: it's ready to merge, or it
 * already has enough approvals. Best-effort — if a lookup fails we deliver the
 * reminder anyway rather than silently drop a needed nudge.
 */
async function remindersNoLongerNeeded(
  deps: ReminderDeps,
  pr: PullRequestRow,
  suppressApprovals: number,
): Promise<boolean> {
  try {
    if (deps.fetchPullRequest) {
      const merge = await deps.fetchPullRequest(pr.repoFullName, pr.number);
      if (merge && READY_TO_MERGE_STATES.has(merge.mergeableState)) return true;
    }
    if (deps.fetchApprovalCount) {
      const approvals = await deps.fetchApprovalCount(pr.repoFullName, pr.number);
      if (typeof approvals === "number" && approvals >= suppressApprovals) return true;
    }
  } catch (err) {
    deps.logger.warn("reminder readiness check failed; delivering anyway", {
      prId: pr.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return false;
}

/** True when a due reminder should stay pending until CI finishes and passes. */
async function reminderWaitingOnCi(deps: ReminderDeps, pr: PullRequestRow): Promise<boolean> {
  if (!deps.fetchCiReadiness || !pr.headSha) return false;
  try {
    const readiness = await deps.fetchCiReadiness(pr.repoFullName, pr.headSha);
    if (readiness === "failing" || readiness === "pending") {
      deps.logger.debug("reminder held: CI is not passing", { prId: pr.id, readiness });
      return true;
    }
  } catch (err) {
    // Fail closed: a lookup error must not ping reviewers while CI might be red.
    deps.logger.warn("reminder CI check failed; holding the reminder", {
      prId: pr.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
  return false;
}

/**
 * Reminder scheduler (U8, R9). A reminder is scheduled 12h out when a review is
 * requested and cancelled when that reviewer submits, the request is removed, or
 * the PR closes/merges. `processDue` claims each due row atomically (KTD10) so
 * concurrent scanners post exactly once.
 */
export function createReminderScheduler(deps: ReminderDeps) {
  const now = deps.now ?? Date.now;
  const suppressApprovals = deps.suppressApprovals ?? DEFAULT_SUPPRESS_APPROVALS;
  const windowMs = deps.reminderHours * 60 * 60_000;
  const leaseMs = deps.reminderLeaseMs ?? 5 * 60_000;
  const maxAttempts = deps.maxAttempts ?? 5;
  const retryBaseMs = deps.retryBaseMs ?? 60_000;
  const batchSize = deps.batchSize ?? 50;
  let localSourceSequence = 0;
  const fallbackSourceVersion = (sourceTime: Date) =>
    `${sourceTime.toISOString()}:${String(++localSourceSequence).padStart(12, "0")}`;

  const onReviewRequested = async (
    prId: string,
    reviewerGithubId: number,
    sourceUpdatedAt?: Date,
    sourceVersion?: string,
  ): Promise<void> => {
    const requestedAt = sourceUpdatedAt ?? new Date(now());
    await scheduleReminder(deps.db, {
      prId,
      reviewerGithubId,
      dueAt: new Date(requestedAt.getTime() + windowMs),
      sourceUpdatedAt: requestedAt,
      sourceVersion: sourceVersion ?? fallbackSourceVersion(requestedAt),
    });
  };

  const cancel = async (
    prId: string,
    reviewerGithubId: number,
    sourceUpdatedAt?: Date,
    sourceVersion?: string,
  ): Promise<void> => {
    const cancelledAt = sourceUpdatedAt ?? new Date(now());
    await cancelForReviewer(
      deps.db,
      prId,
      reviewerGithubId,
      cancelledAt,
      sourceVersion ?? fallbackSourceVersion(cancelledAt),
    );
  };

  const processDue = async (): Promise<number> => {
    const scanTime = new Date(now());
    // Hold all due reminders until the delivery window opens. Checked before any
    // claim so a reminder due off-hours stays pending, not consumed.
    if (deps.deliveryWindow && !isWithinWindow(scanTime, deps.deliveryWindow)) return 0;
    const due = await listDue(deps.db, scanTime, leaseMs, batchSize);
    let posted = 0;
    // One readiness lookup per PR per scan, shared across its reviewers.
    const readiness = new Map<string, boolean>();
    const ciHold = new Map<string, boolean>();
    for (const r of due) {
      const pr = await findById(deps.db, r.prId);
      // Drafts and red/in-progress CI are not claimable yet: claiming would
      // burn the retry budget while we wait for the PR to become reviewable.
      if (pr && !isTerminal(pr.currentState)) {
        if (pr.currentState === "draft") {
          deps.logger.debug("reminder held: PR is still a draft", { prId: r.prId });
          continue;
        }
        let holdForCi = ciHold.get(r.prId);
        if (holdForCi === undefined) {
          holdForCi = await reminderWaitingOnCi(deps, pr);
          ciHold.set(r.prId, holdForCi);
        }
        if (holdForCi) continue;
      }

      const claimed = await claimReminder(deps.db, r.id, scanTime, leaseMs);
      if (!claimed) continue; // lost the race to another scanner

      try {
        if (!pr?.channelId) throw new Error(`Reminder PR channel is unavailable for ${r.prId}`);
        if (isTerminal(pr.currentState)) {
          await cancelReminderClaim(deps.db, claimed);
          continue;
        }

        // Don't nag the channel or any remaining reviewer once the PR is ready
        // to merge or already has enough approvals.
        let ready = readiness.get(r.prId);
        if (ready === undefined) {
          ready = await remindersNoLongerNeeded(deps, pr, suppressApprovals);
          readiness.set(r.prId, ready);
        }
        if (ready) {
          await cancelReminderClaim(deps.db, claimed);
          deps.logger.info("reminder suppressed: PR ready to merge or already approved", {
            prId: r.prId,
            reviewerGithubId: r.reviewerGithubId,
          });
          continue;
        }

        const mapped = await findByGithubId(deps.db, r.reviewerGithubId);
        const mention = mapped ? `<@${mapped.slackUserId}>` : "the requested reviewer";
        if (!(await isReminderClaimCurrent(deps.db, claimed))) continue;

        await deliverSlackMessage(
          deps.db,
          deps.slack,
          {
            prId: r.prId,
            kind: "reminder",
            githubEventRef: `${r.reviewerGithubId}:${claimed.generation}`,
          },
          {
            channel: pr.channelId,
            text: "Reminder: this PR is still waiting for review",
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `⏰ ${mention} — this PR has been waiting ~${deps.reminderHours}h for your review.`,
                },
              },
            ],
          },
        );
        if (await markReminderSent(deps.db, claimed)) posted += 1;
      } catch (err) {
        const retryDelay = retryBaseMs * 2 ** Math.max(0, claimed.attempts - 1);
        const outcome = await rescheduleOrFailReminder(deps.db, claimed, {
          maxAttempts,
          retryAt: new Date(now() + retryDelay),
        });
        deps.logger.error("reminder delivery failed", {
          reminderId: claimed.id,
          attempts: claimed.attempts,
          outcome,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return posted;
  };

  return {
    onReviewRequested,
    onReviewSubmitted: cancel,
    onReviewRequestRemoved: cancel,
    processDue,
  };
}
