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
import { isTerminal } from "../domain/prState.ts";
import type { Logger } from "../logger.ts";
import type { SlackClient } from "../slack/client.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";

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
}

/**
 * Reminder scheduler (U8, R9). A reminder is scheduled 12h out when a review is
 * requested and cancelled when that reviewer submits, the request is removed, or
 * the PR closes/merges. `processDue` claims each due row atomically (KTD10) so
 * concurrent scanners post exactly once.
 */
export function createReminderScheduler(deps: ReminderDeps) {
  const now = deps.now ?? Date.now;
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
    const due = await listDue(deps.db, scanTime, leaseMs, batchSize);
    let posted = 0;
    for (const r of due) {
      const claimed = await claimReminder(deps.db, r.id, scanTime, leaseMs);
      if (!claimed) continue; // lost the race to another scanner

      try {
        const pr = await findById(deps.db, r.prId);
        if (!pr?.channelId) throw new Error(`Reminder PR channel is unavailable for ${r.prId}`);
        if (isTerminal(pr.currentState)) {
          await cancelReminderClaim(deps.db, claimed);
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
