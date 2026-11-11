import type { ReminderRow } from "#db";
import {
  type GithubActor,
  type PullRequestEvent,
  type ReviewEvent,
  type Work,
  isTerminal,
} from "#events";
import { displayName, resolveSlackUser } from "#identity";
import { type PrId, Retry } from "#lib";
import type { ChannelPr, PrSession } from "#pr";
import {
  type SourceStamp,
  cancelForReviewer,
  findReminderForReviewer,
  pushReminderDue,
  scheduleReminder,
} from "#reminders";
import { keys } from "#slack";
import type { ReviewDeps } from "./deps.ts";

type Reviewer = Pick<GithubActor, "id" | "login">;

/**
 * What released a review alert. A pull_request event names its reviewers and
 * the head it saw. A completed check run names neither: its reviewers are the
 * PR's current requested reviewers on GitHub, and its head is the stored one.
 */
export type AlertTrigger =
  | {
      kind: "requested" | "ready_for_review" | "synchronize";
      reviewers: readonly Reviewer[];
      headSha: string;
      draft: boolean;
      stamp: SourceStamp;
    }
  | { kind: "check_run" };

interface AlertPolicy {
  /** An ended reminder (see `ended`) may start a new generation. */
  revive: boolean;
  /**
   * While CI is not ready, record the request on a reminder row, so the alert
   * that follows reuses its generation and a removal can cancel it.
   */
  recordWhenHeld: boolean;
  /**
   * A commit with no check runs by attempt ABSENT_CI_ATTEMPTS has no CI
   * (alert), rather than CI lagging the webhook (hold).
   */
  absentMeansReady: boolean;
}

const alertPolicy: Record<AlertTrigger["kind"], AlertPolicy> = {
  requested: { revive: true, recordWhenHeld: true, absentMeansReady: true },
  ready_for_review: { revive: true, recordWhenHeld: true, absentMeansReady: true },
  synchronize: { revive: false, recordWhenHeld: false, absentMeansReady: true },
  check_run: { revive: false, recordWhenHeld: false, absentMeansReady: false },
};

/**
 * Deliveries to wait for check runs on a commit that has none. The first
 * attempt is 1; attempts below this retry. In-progress runs do not use this
 * budget, since their check_run releases the alert.
 */
const ABSENT_CI_ATTEMPTS = 4;

/** A reviewer the trigger may still alert, with their reminder row if any. */
interface Alertable {
  reviewer: Reviewer;
  reminder: ReminderRow | undefined;
  /** The alert goes out on a new reminder generation: none yet, or a revived one. */
  restart: boolean;
}

/**
 * A request that ended without a review: removed, closed, reviewed, or out
 * of reminder attempts. A sent reminder has not ended, so a re-request after
 * the nudge stays quiet.
 */
const ended = (reminder: ReminderRow) =>
  reminder.status === "cancelled" || reminder.status === "failed";

/** pull_request actions after the session converged the channel. */
export async function onPullRequest(
  deps: ReviewDeps,
  s: PrSession,
  ev: PullRequestEvent,
  work: Work,
): Promise<void> {
  const stamp = eventStamp(ev.pr.updatedAt, work);
  const trigger = (
    kind: "requested" | "ready_for_review" | "synchronize",
    reviewers = ev.pr.requestedReviewers,
  ) => ({ kind, reviewers, headSha: ev.pr.headSha, draft: ev.pr.draft, stamp }) as const;
  switch (ev.action) {
    case "review_requested":
    case "review_request_removed": {
      const pr = await s.ready();
      const reviewer = ev.requestedReviewer;
      if (!reviewer) {
        if (ev.requestedTeam) {
          deps.logger.info("team review requested; no per-user invite", { team: ev.requestedTeam });
        }
        return;
      }
      if (ev.action === "review_request_removed") {
        await cancelForReviewer(deps.db, pr.id, reviewer.id, stamp);
        return;
      }
      return releaseAlerts(deps, s, pr, trigger("requested", [reviewer]), work.attempt);
    }
    case "ready_for_review":
      // GitHub keeps the reviewers requested while the PR was a draft.
      if (ev.pr.requestedReviewers.length === 0) return;
      return releaseAlerts(deps, s, await s.ready(), trigger("ready_for_review"), work.attempt);
    case "synchronize":
      // A head with no check runs never gets a check_run, so the push itself
      // releases alerts held on the previous head's CI.
      if (ev.pr.draft || ev.pr.requestedReviewers.length === 0) return;
      return releaseAlerts(deps, s, await s.ready(), trigger("synchronize"), work.attempt);
  }
}

/**
 * A submitted review, in any state, cancels the reviewer's reminder. Runs
 * before the review is mirrored, so a failed Slack post cannot leave the
 * reminder live for a later check run to alert.
 */
export async function onReviewSubmitted(
  deps: ReviewDeps,
  s: PrSession,
  ev: ReviewEvent,
  work: Work,
): Promise<void> {
  const pr = await s.ready();
  const reviewedAt = sourceDate(ev.review.submittedAt ?? ev.pr.updatedAt) ?? deps.clock.now();
  await cancelForReviewer(deps.db, pr.id, ev.review.author.id, {
    updatedAt: reviewedAt,
    version: work.arrivalKey,
  });
}

/**
 * Alert each reviewer the trigger names, once per reminder generation, while
 * the PR is open, not a draft, and CI on its head passes. A reviewer requested
 * while CI is held gets a reminder row and no post; the trigger that later
 * finds CI passing sends the alert on that row's generation.
 */
export async function releaseAlerts(
  deps: ReviewDeps,
  s: PrSession,
  pr: ChannelPr,
  trigger: AlertTrigger,
  attempt: number,
): Promise<void> {
  const policy = alertPolicy[trigger.kind];
  const named = trigger.kind !== "check_run";
  if (isTerminal(pr.currentState) || pr.currentState === "draft" || (named && trigger.draft)) {
    deps.logger.debug("review alert skipped: PR is closed or a draft", {
      prId: pr.id,
      trigger: trigger.kind,
      state: pr.currentState,
    });
    return;
  }
  const stamp: SourceStamp = named
    ? trigger.stamp
    : { updatedAt: pr.sourceUpdatedAt ?? new Date(0), version: "check-run" };
  const listed = named ? await alertable(deps, s, pr.id, trigger.reviewers, policy.revive) : [];
  if (named && listed.length === 0) return;

  const headSha = named ? trigger.headSha : pr.headSha;
  if (!(await ciAllowsAlert(deps, pr, headSha, policy.absentMeansReady, attempt))) {
    if (policy.recordWhenHeld) {
      for (const one of listed) await recordRequest(deps, pr.id, one, stamp);
    }
    return;
  }
  const pending = named ? listed : await requestedOnGithub(deps, s, pr, policy.revive);
  for (const one of pending) await sendAlert(deps, s, pr.id, one, stamp);
}

/**
 * The reviewers a trigger can still alert. One whose alert for the current
 * generation already posted, or whose request was cancelled when the trigger
 * cannot revive it, has nothing left to send, so they are left out before any
 * CI or GitHub read.
 */
async function alertable(
  deps: ReviewDeps,
  s: PrSession,
  prId: PrId,
  reviewers: readonly Reviewer[],
  revive: boolean,
): Promise<Alertable[]> {
  const out: Alertable[] = [];
  for (const reviewer of reviewers) {
    const reminder = await findReminderForReviewer(deps.db, prId, reviewer.id);
    const restart = !reminder || (revive && ended(reminder));
    const settled =
      !restart &&
      (reminder.status === "cancelled" ||
        (await s.sentTs(keys.reviewRequest(prId, reviewer.id, reminder.generation))) !== undefined);
    if (!settled) out.push({ reviewer, reminder, restart });
  }
  return out;
}

/** A check run's reviewers: the PR's current requested reviewers, unless GitHub says it is a draft. */
async function requestedOnGithub(
  deps: ReviewDeps,
  s: PrSession,
  pr: ChannelPr,
  revive: boolean,
): Promise<Alertable[]> {
  const pull = await deps.fetchPullRequest(pr.repoFullName, pr.number);
  if (!pull) throw new Retry(`pull request ${pr.repoFullName}#${pr.number} is not readable yet`);
  if (pull.draft) return [];
  return alertable(deps, s, pr.id, pull.requestedReviewers ?? [], revive);
}

async function ciAllowsAlert(
  deps: ReviewDeps,
  pr: ChannelPr,
  headSha: string | null,
  absentMeansReady: boolean,
  attempt: number,
): Promise<boolean> {
  if (!headSha) return false;
  const readiness = await deps.fetchCiReadiness(pr.repoFullName, headSha);
  if (readiness === "passing") return true;
  if (readiness !== "absent") {
    deps.logger.info("review alert held: CI is not passing", { prId: pr.id, readiness, headSha });
    return false;
  }
  if (attempt < ABSENT_CI_ATTEMPTS) {
    throw new Retry(`CI has not reported yet for ${pr.repoFullName}#${pr.number}`, {
      headSha,
      attempt,
    });
  }
  if (absentMeansReady) return true;
  deps.logger.info("review alert held: check runs have not registered", { prId: pr.id, headSha });
  return false;
}

async function recordRequest(
  deps: ReviewDeps,
  prId: PrId,
  { reviewer, restart }: Alertable,
  stamp: SourceStamp,
): Promise<void> {
  if (!restart) return;
  await scheduleReminder(deps.db, {
    prId,
    reviewerGithubId: reviewer.id,
    dueAt: hoursAfter(deps, stamp.updatedAt),
    stamp,
  });
  deps.logger.info("review alert held until CI passes", { prId, reviewer: reviewer.login });
}

/**
 * Post the alert keyed by the reminder generation, which changes only when a
 * request replaces an ended one, so every trigger for one request shares
 * one post. The reminder clock restarts in the transaction that records it.
 */
async function sendAlert(
  deps: ReviewDeps,
  s: PrSession,
  prId: PrId,
  { reviewer, reminder, restart }: Alertable,
  stamp: SourceStamp,
): Promise<void> {
  let current = reminder;
  if (restart || !current) {
    current = await scheduleReminder(deps.db, {
      prId,
      reviewerGithubId: reviewer.id,
      dueAt: hoursAfter(deps, stamp.updatedAt),
      stamp,
    });
    // A request older than the reminder's end does not revive it.
    if (ended(current)) return;
  }
  await s.deliver(
    keys.reviewRequest(prId, reviewer.id, current.generation),
    async () => {
      const slackUserId = await resolveSlackUser(deps, {
        githubId: reviewer.id,
        login: reviewer.login,
      });
      if (!slackUserId) {
        deps.logger.info("reviewer identity unresolved; posting plain login", {
          login: reviewer.login,
        });
        return { message: { kind: "review_request", reviewerLogin: reviewer.login } };
      }
      const channel = await s.channel();
      return {
        message: {
          kind: "review_request",
          reviewerLogin: reviewer.login,
          reviewerLabel: await displayName(deps, slackUserId, reviewer.login),
        },
        beforePost: () => channel.invite([slackUserId], { prId, role: "reviewer" }),
      };
    },
    {
      onSentTx: (tx) => pushReminderDue(tx, prId, reviewer.id, hoursAfter(deps, deps.clock.now())),
    },
  );
}

const hoursAfter = (deps: ReviewDeps, at: Date) =>
  new Date(at.getTime() + deps.reminderHours * 60 * 60_000);

function eventStamp(updatedAt: string, work: Work): SourceStamp {
  return { updatedAt: sourceDate(updatedAt) ?? new Date(0), version: work.arrivalKey };
}

function sourceDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
