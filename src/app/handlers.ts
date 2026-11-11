import { type DomainEvent, type Work, jobArrivalKey, parseEvent } from "#events";
import { shouldSkipActor } from "#github";
import { type MirrorDeps, mirrorReview, onIssueComment, onReviewComment } from "#mirror";
import { session } from "#pr";
import type { Dispatch } from "#queue";
import { type ReviewDeps, onCheckRun, onPullRequest, onReviewSubmitted } from "#reviews";

export interface HandlerDeps extends MirrorDeps, ReviewDeps {}

type Handler<K extends DomainEvent["kind"]> = (
  deps: HandlerDeps,
  ev: Extract<DomainEvent, { kind: K }>,
  work: Work,
) => Promise<void>;

/** One entry per DomainEvent kind; a missing entry does not compile. */
export type HandlerTable = { [K in DomainEvent["kind"]]: Handler<K> };

export const handlers: HandlerTable = {
  pull_request: (deps, ev, work) => {
    const cause = {
      kind: "pull_request",
      action: ev.action,
      merged: ev.merged,
      arrivalKey: work.arrivalKey,
    } as const;
    return session(
      deps,
      { kind: "snapshot", snapshot: ev.pr, cause },
      (s) => onPullRequest(deps, s, ev, work),
      work.signal,
    );
  },
  review_comment: (deps, ev, work) => onReviewComment(deps, ev, work),
  review: async (deps, ev, work) => {
    if (shouldSkipActor(ev.review.author, deps.allowedBots)) return;
    await session(
      deps,
      { kind: "snapshot", snapshot: ev.pr, cause: { kind: "child" } },
      async (s) => {
        // Cancel before any Slack I/O, so a failed post cannot leave the
        // reminder live for a later check run to alert.
        await onReviewSubmitted(deps, s, ev, work);
        await mirrorReview(deps, s, ev);
      },
      work.signal,
    );
  },
  issue_comment: (deps, ev, work) => onIssueComment(deps, ev, work.signal),
  check_run: (deps, ev, work) => onCheckRun(deps, ev, work),
  ignored: async (deps, ev) => {
    deps.logger.debug("unhandled event", { event: ev.event, action: ev.action, reason: ev.reason });
  },
};

/** Run a persisted job's event through its handler. */
export function createDispatcher(deps: HandlerDeps): Dispatch {
  return async (job, signal) => {
    const event = parseEvent(job.event, job.raw);
    const work: Work = {
      arrivalKey: jobArrivalKey(job.createdAt, job.id),
      attempt: job.attempts,
      signal,
    };
    // The mapped type pairs each kind with its handler; TS cannot correlate the two lookups.
    const handle = handlers[event.kind] as Handler<DomainEvent["kind"]>;
    return handle(deps, event, work);
  };
}
