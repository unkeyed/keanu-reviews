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
  releaseReminderClaim,
  scheduleReminder,
} from "../db/repositories/reminders.ts";
import { isTerminal } from "../domain/prState.ts";
import type { Logger } from "../logger.ts";
import type { SlackClient } from "../slack/client.ts";

export interface ReminderDeps {
  db: Db;
  slack: SlackClient;
  logger: Logger;
  reminderHours: number;
  reminderLeaseMs?: number;
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

  const onReviewRequested = async (prId: string, reviewerGithubId: number): Promise<void> => {
    await scheduleReminder(deps.db, {
      prId,
      reviewerGithubId,
      dueAt: new Date(now() + windowMs),
    });
  };

  const cancel = (prId: string, reviewerGithubId: number) =>
    cancelForReviewer(deps.db, prId, reviewerGithubId);

  const processDue = async (): Promise<number> => {
    const scanTime = new Date(now());
    const due = await listDue(deps.db, scanTime, leaseMs);
    let posted = 0;
    for (const r of due) {
      const claimed = await claimReminder(deps.db, r.id, scanTime, leaseMs);
      if (!claimed) continue; // lost the race to another scanner

      const pr = await findById(deps.db, r.prId);
      if (!pr?.channelId) {
        await releaseReminderClaim(deps.db, claimed);
        continue;
      }
      if (isTerminal(pr.currentState)) {
        await cancelReminderClaim(deps.db, claimed);
        continue;
      }

      const mapped = await findByGithubId(deps.db, r.reviewerGithubId);
      const mention = mapped ? `<@${mapped.slackUserId}>` : "the requested reviewer";
      if (!(await isReminderClaimCurrent(deps.db, claimed))) continue;

      try {
        await deps.slack.postMessage({
          channel: pr.channelId,
          text: "Reminder: this PR is still waiting for review",
          threadTs: pr.rootMessageTs ?? undefined,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `⏰ ${mention} — this PR has been waiting ~${deps.reminderHours}h for your review.`,
              },
            },
          ],
        });
      } catch (err) {
        await releaseReminderClaim(deps.db, claimed);
        throw err;
      }
      await markReminderSent(deps.db, claimed);
      posted += 1;
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
