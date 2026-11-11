import type { Db } from "#db";
import type { Logger, PrId } from "#lib";
import { cancelForReviewer, pushReminderDue, scheduleReminder } from "#reminders";
import type { SlackGateway } from "#slack";

export interface ReminderDeps {
  db: Db;
  slack: SlackGateway;
  logger: Logger;
  reminderHours: number;
  now?: () => number;
}

/**
 * Reminder hooks for review requests: schedule a reminder 12h out, cancel it
 * when the reviewer submits or the request is removed, and restart its clock
 * when the review alert posts.
 */
export function createReminderScheduler(deps: ReminderDeps) {
  const now = deps.now ?? Date.now;
  const windowMs = deps.reminderHours * 60 * 60_000;
  let localSourceSequence = 0;
  const fallbackSourceVersion = (sourceTime: Date) =>
    `${sourceTime.toISOString()}:${String(++localSourceSequence).padStart(12, "0")}`;

  const onReviewRequested = async (
    prId: PrId,
    reviewerGithubId: number,
    sourceUpdatedAt?: Date,
    sourceVersion?: string,
  ): Promise<void> => {
    const requestedAt = sourceUpdatedAt ?? new Date(now());
    await scheduleReminder(deps.db, {
      prId,
      reviewerGithubId,
      dueAt: new Date(requestedAt.getTime() + windowMs),
      stamp: {
        updatedAt: requestedAt,
        version: sourceVersion ?? fallbackSourceVersion(requestedAt),
      },
    });
  };

  const cancel = async (
    prId: PrId,
    reviewerGithubId: number,
    sourceUpdatedAt?: Date,
    sourceVersion?: string,
  ): Promise<void> => {
    const cancelledAt = sourceUpdatedAt ?? new Date(now());
    await cancelForReviewer(deps.db, prId, reviewerGithubId, {
      updatedAt: cancelledAt,
      version: sourceVersion ?? fallbackSourceVersion(cancelledAt),
    });
  };

  const onReviewAlerted = async (prId: PrId, reviewerGithubId: number): Promise<void> => {
    await pushReminderDue(deps.db, prId, reviewerGithubId, new Date(now() + windowMs));
  };

  return {
    onReviewRequested,
    onReviewSubmitted: cancel,
    onReviewRequestRemoved: cancel,
    onReviewAlerted,
  };
}
