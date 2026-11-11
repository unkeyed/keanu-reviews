import type { ReminderRow } from "#db";
import { isTerminal } from "#events";
import type { PullRequestMergeability } from "#github";
import { type PrId, errMessage } from "#lib";
import { type PrSession, PullRequestLifecycleBusyError, session } from "#pr";
import {
  type DuePr,
  type DueReminder,
  cancelReminderClaim,
  claimReminder,
  deferReminder,
  isReminderClaimCurrent,
  listDueWithContext,
  markReminderSent,
  rescheduleOrFailReminder,
  restartReminderClaim,
} from "#reminders";
import { keys } from "#slack";
import { deliverAlert } from "./alerts.ts";
import type { ReviewDeps } from "./deps.ts";
import { isWithinWindow } from "./window.ts";

const BATCH = 50;
const HOLD_MS = 15 * 60_000;
const READY_TO_MERGE_STATES = new Set(["clean", "has_hooks"]);

type HoldReason = "draft" | "no_channel" | "ci";

interface DueGroup {
  prId: string;
  pr: DuePr;
  rows: DueReminder[];
}

export async function scanDue(deps: ReviewDeps): Promise<number> {
  const now = deps.clock.now();
  if (!isWithinWindow(now, deps.reminderWindow)) return 0;
  let posted = 0;
  for (const group of groupByPr(await listDueWithContext(deps.db, now, BATCH))) {
    posted += await remindPr(deps, group, now);
  }
  return posted;
}

function groupByPr(due: readonly DueReminder[]): DueGroup[] {
  const groups = new Map<string, DueGroup>();
  for (const row of due) {
    const prId = row.reminder.prId;
    const group = groups.get(prId);
    if (group) group.rows.push(row);
    else groups.set(prId, { prId, pr: row.pr, rows: [row] });
  }
  return [...groups.values()];
}

async function remindPr(deps: ReviewDeps, group: DueGroup, now: Date): Promise<number> {
  const { pr } = group;
  if (!isTerminal(pr.currentState)) {
    const hold = await holdReason(deps, group.prId, pr);
    if (hold) {
      const until = new Date(now.getTime() + HOLD_MS);
      for (const { reminder } of group.rows) {
        await deferReminder(deps.db, reminder, until, now);
        deps.logger.debug("reminder held", { prId: group.prId, reason: hold, until });
      }
      return 0;
    }
  }
  try {
    return await session(deps, { kind: "existing", githubPrId: pr.githubPrId }, (s) =>
      remind(deps, s, group, now),
    );
  } catch (err) {
    if (!(err instanceof PullRequestLifecycleBusyError)) throw err;
    deps.logger.debug("reminders skipped: PR is busy", { prId: group.prId });
    return 0;
  }
}

async function remind(
  deps: ReviewDeps,
  s: PrSession,
  { prId, pr, rows }: DueGroup,
  now: Date,
): Promise<number> {
  const { db, logger } = deps;
  let pull: Promise<PullRequestMergeability | undefined> | undefined;
  let suppressed: Promise<boolean> | undefined;
  let posted = 0;
  for (const { reminder, reviewerSlackUserId } of rows) {
    const claim = await claimReminder(db, reminder.id, now);
    if (!claim) continue;
    try {
      if (isTerminal(pr.currentState)) {
        await cancelReminderClaim(db, claim);
        continue;
      }
      pull ??= deps.fetchPullRequest(pr.repoFullName, pr.number);
      suppressed ??= noLongerNeeded(deps, prId, pr, pull);
      if (await suppressed) {
        await cancelReminderClaim(db, claim);
        logger.info("reminder suppressed: PR ready to merge or already approved", {
          prId,
          reviewerGithubId: claim.reviewerGithubId,
        });
        continue;
      }
      if (!(await isReminderClaimCurrent(db, claim))) continue;
      const { id } = await s.channelPr();
      if (!(await s.sentTs(keys.reviewRequest(id, claim.reviewerGithubId, claim.generation)))) {
        await healAlert(deps, s, id, claim, await pull);
        continue;
      }
      await s.deliver(keys.reminder(id, claim.reviewerGithubId, claim.generation), async () => ({
        message: { kind: "reminder", reviewer: reviewerSlackUserId, hours: deps.reminderHours },
      }));
      if (await markReminderSent(db, claim)) posted += 1;
    } catch (err) {
      const outcome = await rescheduleOrFailReminder(db, claim, deps.clock.now());
      logger.error("reminder delivery failed", {
        reminderId: claim.id,
        attempts: claim.attempts,
        outcome,
        err: errMessage(err),
      });
    }
  }
  return posted;
}

async function healAlert(
  deps: ReviewDeps,
  s: PrSession,
  prId: PrId,
  claim: ReminderRow,
  pull: PullRequestMergeability | undefined,
): Promise<void> {
  if (!pull) throw new Error(`pull request ${prId} is not readable`);
  const reviewer = pull.requestedReviewers?.find((one) => one.id === claim.reviewerGithubId);
  if (!reviewer) {
    await cancelReminderClaim(deps.db, claim);
    deps.logger.info("reminder cancelled: reviewer is no longer requested", {
      prId,
      reviewerGithubId: claim.reviewerGithubId,
    });
    return;
  }
  await deliverAlert(deps, s, prId, reviewer, claim.generation, (tx, dueAt) =>
    restartReminderClaim(tx, claim, dueAt),
  );
  deps.logger.info("posted a review alert the scan found missing", {
    prId,
    reviewerGithubId: claim.reviewerGithubId,
  });
}

async function holdReason(
  deps: ReviewDeps,
  prId: string,
  pr: DuePr,
): Promise<HoldReason | undefined> {
  if (pr.currentState === "draft") return "draft";
  if (!pr.channelId) return "no_channel";
  if (pr.headSha && (await ciHolds(deps, prId, pr.repoFullName, pr.headSha))) return "ci";
  return undefined;
}

async function ciHolds(
  deps: ReviewDeps,
  prId: string,
  repoFullName: string,
  headSha: string,
): Promise<boolean> {
  try {
    const readiness = await deps.fetchCiReadiness(repoFullName, headSha);
    if (readiness !== "failing" && readiness !== "pending") return false;
    deps.logger.debug("reminder held: CI is not passing", { prId, readiness });
    return true;
  } catch (err) {
    deps.logger.warn("reminder CI check failed; holding the reminder", {
      prId,
      err: errMessage(err),
    });
    return true;
  }
}

async function noLongerNeeded(
  deps: ReviewDeps,
  prId: string,
  pr: DuePr,
  pullRead: Promise<PullRequestMergeability | undefined>,
): Promise<boolean> {
  const [pull, approvals] = await Promise.allSettled([
    pullRead,
    deps.fetchApprovalCount(pr.repoFullName, pr.number),
  ]);
  const deliverAnyway = (err: unknown) => {
    deps.logger.warn("reminder readiness check failed; delivering anyway", {
      prId,
      err: errMessage(err),
    });
    return false;
  };
  if (pull.status === "rejected") return deliverAnyway(pull.reason);
  if (pull.value && READY_TO_MERGE_STATES.has(pull.value.mergeableState)) return true;
  if (approvals.status === "rejected") return deliverAnyway(approvals.reason);
  return typeof approvals.value === "number" && approvals.value >= deps.suppressApprovals;
}
