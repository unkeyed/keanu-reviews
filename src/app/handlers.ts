import type { JobRow } from "#db";
import { type DomainEvent, jobArrivalKey, parseEvent } from "#events";
import type { ArrivalKey } from "#lib";
import { session } from "#pr";
import { type ChecksDeps, handleCheckRun } from "../handlers/checks.ts";
import { type ReviewDeps, handleIssueComment, handleReview } from "../handlers/review.ts";
import { handleReviewComment } from "../handlers/reviewComment.ts";
import {
  handleReadyForReview,
  handleReviewRequest,
  handleSynchronizedReviewAlerts,
} from "../handlers/reviewRequest.ts";

export interface HandlerDeps extends ChecksDeps, ReviewDeps {}

/** What a handler knows about the job carrying its event. */
export interface Work {
  arrivalKey: ArrivalKey;
  /** 1-based. */
  attempt: number;
}

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
    return session(deps, { snapshot: ev.pr, cause }, async (s) => {
      const gate = { attempt: work.attempt };
      switch (ev.action) {
        case "review_requested":
        case "review_request_removed":
          return handleReviewRequest(deps, s, ev, work.arrivalKey, gate);
        case "ready_for_review":
          // Invite reviewers assigned while the PR was a draft, once check runs pass.
          return handleReadyForReview(deps, s, ev, work.arrivalKey, gate);
        case "synchronize":
          return handleSynchronizedReviewAlerts(deps, s, ev, work.arrivalKey, gate);
      }
    });
  },
  review_comment: (deps, ev) => handleReviewComment(deps, ev),
  review: (deps, ev, work) => handleReview(deps, ev, work.arrivalKey),
  issue_comment: (deps, ev) => handleIssueComment(deps, ev),
  check_run: (deps, ev, work) => handleCheckRun(deps, ev, { attempt: work.attempt }),
  ignored: async (deps, ev) => {
    deps.logger.debug("unhandled event", { event: ev.event, action: ev.action, reason: ev.reason });
  },
};

/** Run a persisted job's event through its handler. */
export function createDispatcher(deps: HandlerDeps): (job: JobRow) => Promise<void> {
  return async (job) => {
    const event = parseEvent(job.event, job.raw);
    const work: Work = {
      arrivalKey: jobArrivalKey(job.createdAt, job.id),
      attempt: job.attempts,
    };
    // The mapped type pairs each kind with its handler; TS cannot correlate the two lookups.
    const handle = handlers[event.kind] as Handler<DomainEvent["kind"]>;
    return handle(deps, event, work);
  };
}
