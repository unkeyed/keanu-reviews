import { eq } from "drizzle-orm";
import { type Db, pullRequests } from "#db";
import { type PrState, type PullRequestEvent, jobArrivalKey } from "#events";
import type { ArrivalKey } from "#lib";
import { type PrDeps, type PrSession, session } from "#pr";
import type { ConvergeOutcome } from "../pr/converge.ts";
import type { PrSource } from "../pr/session.ts";

/** Move a seeded PR to a state without a GitHub event, as a stale or racing row would be. */
export async function setPrState(db: Db, id: string, state: PrState): Promise<void> {
  await db
    .update(pullRequests)
    .set({ currentState: state, updatedAt: new Date() })
    .where(eq(pullRequests.id, id));
}

let arrivals = 0;

/** A job arrival key that sorts after every key minted before it. */
function nextArrival(): ArrivalKey {
  arrivals += 1;
  return jobArrivalKey(new Date(0), String(arrivals).padStart(8, "0"));
}

/** The session source the handler table opens for a pull_request job. */
function pullRequestSource(ev: PullRequestEvent, arrivalKey = nextArrival()): PrSource {
  const cause = { kind: "pull_request", action: ev.action, merged: ev.merged, arrivalKey } as const;
  return { kind: "snapshot", snapshot: ev.pr, cause };
}

/** Converge a pull_request job's channel, without the review step that follows it. */
export function convergePullRequest(
  deps: PrDeps,
  ev: PullRequestEvent,
  arrivalKey?: ArrivalKey,
): Promise<ConvergeOutcome | undefined> {
  return session(deps, pullRequestSource(ev, arrivalKey), async (s) => s.converged);
}

/**
 * A pull_request job's review step, run in a session for its PR. The PR row a
 * test seeds stands in for the convergence the job runs first.
 */
export function inSession<D extends PrDeps, A extends unknown[]>(
  step: (deps: D, s: PrSession, ev: PullRequestEvent, ...rest: A) => Promise<void>,
): (deps: D, ev: PullRequestEvent, ...rest: A) => Promise<void> {
  return (deps, ev, ...rest) =>
    session(deps, { kind: "snapshot", snapshot: ev.pr, cause: { kind: "child" } }, (s) =>
      step(deps, s, ev, ...rest),
    );
}
