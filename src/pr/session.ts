import { AsyncLocalStorage } from "node:async_hooks";
import type { PrSnapshot } from "#events";
import { Retry, errMessage, leaseWaitMs } from "#lib";
import {
  type DeliverOptions,
  type Delivered,
  type EffectKey,
  type Outgoing,
  createLedger,
} from "#slack";
import { type PrChannel, prChannel } from "./channel.ts";
import { type ConvergeOutcome, type PrDeps, converge } from "./converge.ts";
import { inviteMentions } from "./mentions.ts";
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

/** A PR row whose channel exists. */
export type ChannelPr = PrRow & { channelId: string };

/** Work inside a session writes to the PR's channel only through it. */
export interface PrSession {
  /** The channel convergence this session ran on entry; undefined for a child event or an existing PR. */
  readonly converged: ConvergeOutcome | undefined;
  /**
   * The PR with its channel and root. For a snapshot, a missing one is built
   * as a child event would; still missing means retry later.
   */
  ready(): Promise<ReadyPr>;
  /**
   * The PR whose channel this session writes: a snapshot's ready PR, or an
   * existing PR's stored row, which needs no root. A missing channel means
   * retry later.
   */
  channelPr(): Promise<ChannelPr>;
  /** The writer for the channel of `channelPr()`. */
  channel(): Promise<PrChannel>;
  /** Post into the PR channel at most once per key. */
  deliver<B extends Outgoing | null>(
    key: EffectKey,
    build: () => Promise<B>,
    opts?: DeliverOptions,
  ): Promise<Delivered<B>>;
  /** The Slack ts of an effect already posted, else undefined. */
  sentTs(key: EffectKey): Promise<string | undefined>;
  /** Keep an effect from ever posting; returns the ts of one that already posted. */
  tombstone(key: EffectKey): Promise<string | undefined>;
  /**
   * Invite the Slack users linked to the GitHub logins @-mentioned in `body`,
   * except `excludeLogin`. A lookup or invite failure is logged, not thrown.
   */
  inviteMentions(body: string, excludeLogin: string | undefined): Promise<void>;
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
 * since a nested one would wait on its own queue. Once `signal` aborts, the
 * session stops renewing its lease and starts no further Slack delivery.
 */
export async function session<T>(
  deps: PrDeps,
  source: PrSource,
  body: (s: PrSession) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const outer = inSession.getStore();
  if (outer !== undefined) throw new Error(`PR session for ${outer} cannot open another`);
  const githubPrId = source.kind === "snapshot" ? source.snapshot.githubPrId : source.githubPrId;
  return inLane(githubPrId, () =>
    inSession.run(githubPrId, () =>
      leased(deps, githubPrId, signal, async () => {
        if (source.kind === "existing") {
          return body(
            prSession(deps, signal, undefined, {
              ready: () => stored(deps, githubPrId),
              channel: () => storedChannel(deps, githubPrId),
            }),
          );
        }
        const converged =
          source.cause.kind === "child"
            ? undefined
            : await converge(deps, source.snapshot, source.cause);
        const readyPr = () => ready(deps, source.snapshot);
        return body(prSession(deps, signal, converged, { ready: readyPr, channel: readyPr }));
      }),
    ),
  );
}

/** Each lookup runs at most once: under the lease, nothing else changes the row it reads. */
function prSession(
  deps: PrDeps,
  signal: AbortSignal | undefined,
  converged: ConvergeOutcome | undefined,
  find: { ready: () => Promise<ReadyPr>; channel: () => Promise<ChannelPr> },
): PrSession {
  const ledger = createLedger(deps.db);
  let readyPr: Promise<ReadyPr> | undefined;
  let channelPr: Promise<ChannelPr> | undefined;
  let channel: Promise<PrChannel> | undefined;
  const s: PrSession = {
    converged,
    ready: () => {
      readyPr ??= find.ready();
      return readyPr;
    },
    channelPr: () => {
      channelPr ??= find.channel();
      return channelPr;
    },
    channel: () => {
      channel ??= s.channelPr().then((row) => prChannel(deps, row.channelId));
      return channel;
    },
    deliver: (async (key, build, opts) => {
      const channel = await s.channel();
      signal?.throwIfAborted();
      return ledger.deliver(key, channel, build, opts);
    }) as PrSession["deliver"],
    sentTs: (key) => ledger.sentTs(key),
    tombstone: (key) => ledger.tombstone(key),
    inviteMentions: async (body, excludeLogin) =>
      inviteMentions(deps, await s.channel(), body, excludeLogin),
  };
  return s;
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

async function leased<T>(
  deps: PrDeps,
  githubPrId: number,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const { db, logger } = deps;
  signal?.throwIfAborted();
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
    if (signal?.aborted) {
      clearInterval(renewal);
      return;
    }
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

async function storedChannel(deps: PrDeps, githubPrId: number): Promise<ChannelPr> {
  const row = await findByGithubPrId(deps.db, githubPrId);
  if (!hasChannel(row)) throw new Retry(`PR channel is not ready for GitHub PR ${githubPrId}`);
  return row;
}

function hasChannel(row: PrRow | undefined): row is ChannelPr {
  return Boolean(row?.channelId);
}

function isReady(row: PrRow | undefined): row is ReadyPr {
  return Boolean(row?.channelId && row.rootMessageTs);
}
