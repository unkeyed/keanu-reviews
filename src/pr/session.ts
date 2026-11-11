import { AsyncLocalStorage } from "node:async_hooks";
import type { PrSnapshot } from "#events";
import { Retry, errMessage, leaseWaitMs } from "#lib";
import { type ConvergeOutcome, type PrDeps, converge } from "./converge.ts";
import type { ConvergeCause } from "./plan.ts";
import {
  PULL_REQUEST_LIFECYCLE_LEASE_MS,
  type PrRow,
  claimPullRequestLifecycle,
  findByGithubPrId,
  findByRepoNumber,
  pullRequestLifecycleClaimedAt,
  releasePullRequestLifecycle,
  renewPullRequestLifecycle,
} from "./store.ts";

/**
 * Which PR a session is for. A snapshot is GitHub's view of the PR and why the
 * work runs. An existing PR is only locked: nothing converges, and a missing
 * channel stays missing.
 */
export type PrSource =
  | { kind: "snapshot"; snapshot: PrSnapshot; cause: ConvergeCause }
  | { kind: "existing"; githubPrId: number };

/** A PR row whose channel and root message exist. */
export type ReadyPr = PrRow & { channelId: string; rootMessageTs: string };

export interface PrSession {
  /** The channel convergence this session ran on entry; undefined for a child event or an existing PR. */
  readonly converged: ConvergeOutcome | undefined;
  /**
   * The PR with its channel and root. For a snapshot, a missing one is built
   * as a child event would; still missing means retry later.
   */
  ready(): Promise<ReadyPr>;
}

/** Another replica holds the PR; a retry waits until a crashed holder's lease can be taken over. */
export class PullRequestLifecycleBusyError extends Retry {
  constructor(githubPrId: number, retryAfterMs?: number) {
    super(`GitHub PR ${githubPrId} is already being reconciled`, { githubPrId }, retryAfterMs);
    this.name = "PullRequestLifecycleBusyError";
  }
}

const RENEW_EVERY_MS = PULL_REQUEST_LIFECYCLE_LEASE_MS / 3;

/** Session tails per GitHub PR id, so work on one PR in this process runs in arrival order. */
const lanes = new Map<number, Promise<void>>();
const inSession = new AsyncLocalStorage<number>();

/**
 * The one way to work on a PR. Work on the same PR runs one at a time: first
 * in this process's queue for the PR, then under the cross-replica lifecycle
 * lease, which is renewed while the work runs. A `pull_request` or
 * `reconcile` cause converges the channel before `body` runs; a child event
 * converges only when the body asks for a ready PR. Sessions do not nest,
 * since a nested one would wait on its own queue.
 */
export async function session<T>(
  deps: PrDeps,
  source: PrSource,
  body: (s: PrSession) => Promise<T>,
): Promise<T> {
  const outer = inSession.getStore();
  if (outer !== undefined) throw new Error(`PR session for ${outer} cannot open another`);
  const githubPrId = source.kind === "snapshot" ? source.snapshot.githubPrId : source.githubPrId;
  return inLane(githubPrId, () =>
    inSession.run(githubPrId, () =>
      leased(deps, githubPrId, async () => {
        if (source.kind === "existing") {
          return body({ converged: undefined, ready: () => stored(deps, githubPrId) });
        }
        const converged =
          source.cause.kind === "child"
            ? undefined
            : await converge(deps, source.snapshot, source.cause);
        return body({ converged, ready: () => ready(deps, source.snapshot) });
      }),
    ),
  );
}

function inLane<T>(githubPrId: number, run: () => Promise<T>): Promise<T> {
  const result = (lanes.get(githubPrId) ?? Promise.resolve()).then(run);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  lanes.set(githubPrId, tail);
  void tail.then(() => {
    if (lanes.get(githubPrId) === tail) lanes.delete(githubPrId);
  });
  return result;
}

async function leased<T>(deps: PrDeps, githubPrId: number, run: () => Promise<T>): Promise<T> {
  const { db, logger } = deps;
  const claim = await claimPullRequestLifecycle(db, githubPrId);
  if (!claim) {
    throw new PullRequestLifecycleBusyError(
      githubPrId,
      leaseWaitMs(
        await pullRequestLifecycleClaimedAt(db, githubPrId),
        PULL_REQUEST_LIFECYCLE_LEASE_MS,
        new Date(),
      ),
    );
  }
  const renewal = setInterval(() => {
    renewPullRequestLifecycle(db, claim, new Date()).then(
      (held) => {
        if (!held) clearInterval(renewal);
      },
      (err) => {
        logger.warn("PR lifecycle lease renewal failed", { githubPrId, err: errMessage(err) });
      },
    );
  }, RENEW_EVERY_MS);
  renewal.unref();
  try {
    return await run();
  } finally {
    clearInterval(renewal);
    if (!(await releasePullRequestLifecycle(db, claim))) {
      logger.error("PR lifecycle lease was lost before release", { githubPrId });
    }
  }
}

async function ready(deps: PrDeps, snapshot: PrSnapshot): Promise<ReadyPr> {
  let row = await findByRepoNumber(deps.db, snapshot.repo, snapshot.number);
  if (!isReady(row)) {
    await converge(deps, snapshot, { kind: "child" });
    row = await findByRepoNumber(deps.db, snapshot.repo, snapshot.number);
  }
  if (!isReady(row)) {
    throw new Retry(`PR channel is not ready for ${snapshot.repo}#${snapshot.number}`);
  }
  return row;
}

async function stored(deps: PrDeps, githubPrId: number): Promise<ReadyPr> {
  const row = await findByGithubPrId(deps.db, githubPrId);
  if (!isReady(row)) throw new Retry(`PR channel is not ready for GitHub PR ${githubPrId}`);
  return row;
}

function isReady(row: PrRow | undefined): row is ReadyPr {
  return Boolean(row?.channelId && row.rootMessageTs);
}
