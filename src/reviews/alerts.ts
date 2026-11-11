import type { Db, ReminderRow } from "#db";
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

export type Reviewer = Pick<GithubActor, "id" | "login">;

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
  revive: boolean;
  recordWhenHeld: boolean;
  absentMeansReady: boolean;
}

const alertPolicy: Record<AlertTrigger["kind"], AlertPolicy> = {
  requested: { revive: true, recordWhenHeld: true, absentMeansReady: true },
  ready_for_review: { revive: true, recordWhenHeld: true, absentMeansReady: true },
  synchronize: { revive: false, recordWhenHeld: false, absentMeansReady: true },
  check_run: { revive: false, recordWhenHeld: false, absentMeansReady: false },
};

const ABSENT_CI_ATTEMPTS = 4;

interface Alertable {
  reviewer: Reviewer;
  reminder: ReminderRow | undefined;
  restart: boolean;
}

const ended = (reminder: ReminderRow) =>
  reminder.status === "cancelled" || reminder.status === "failed";

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
      if (ev.pr.requestedReviewers.length === 0) return;
      return releaseAlerts(deps, s, await s.ready(), trigger("ready_for_review"), work.attempt);
    case "synchronize":
      if (ev.pr.draft || ev.pr.requestedReviewers.length === 0) return;
      return releaseAlerts(deps, s, await s.ready(), trigger("synchronize"), work.attempt);
  }
}

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
    if (ended(current)) return;
  }
  await deliverAlert(deps, s, prId, reviewer, current.generation, (tx, dueAt) =>
    pushReminderDue(tx, prId, reviewer.id, dueAt),
  );
}

export async function deliverAlert(
  deps: ReviewDeps,
  s: PrSession,
  prId: PrId,
  reviewer: Reviewer,
  generation: number,
  restartClock: (tx: Db, dueAt: Date) => Promise<void>,
): Promise<void> {
  await s.deliver(
    keys.reviewRequest(prId, reviewer.id, generation),
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
    { onSentTx: (tx) => restartClock(tx, hoursAfter(deps, deps.clock.now())) },
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
