import { AsyncLocalStorage } from "node:async_hooks";
import { type PrSnapshot, isTerminal } from "#events";
import { Retry, errMessage, leaseWaitMs } from "#lib";
import {
  type DeliverOptions,
  type Delivered,
  type EffectKey,
  type EffectState,
  type Outgoing,
  SlackApiError,
  createLedger,
} from "#slack";
import { type PrChannel, prChannel } from "./channel.ts";
import { type ConvergeOutcome, type PrDeps, converge, followNewerSnapshot } from "./converge.ts";
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

export type PrSource =
  | { kind: "snapshot"; snapshot: PrSnapshot; cause: ConvergeCause }
  | { kind: "existing"; githubPrId: number };

export type ReadyPr = PrRow & { channelId: string; rootMessageTs: string };

export type ChannelPr = PrRow & { channelId: string };

export interface PrSession {
  readonly converged: ConvergeOutcome | undefined;
  ready(): Promise<ReadyPr>;
  channelPr(): Promise<ChannelPr>;
  channel(): Promise<PrChannel>;
  deliver<B extends Outgoing | null>(
    key: EffectKey,
    build: () => Promise<B>,
    opts?: DeliverOptions,
  ): Promise<Delivered<B>>;
  state(key: EffectKey): Promise<EffectState>;
  sentTs(key: EffectKey): Promise<string | undefined>;
  tombstone(key: EffectKey): Promise<string | undefined>;
  inviteMentions(body: string, excludeLogin: string | undefined): Promise<void>;
}

export class PullRequestLifecycleBusyError extends Retry {
  constructor(githubPrId: number, retryAfterMs?: number) {
    super(`GitHub PR ${githubPrId} is already being reconciled`, { githubPrId }, retryAfterMs);
    this.name = "PullRequestLifecycleBusyError";
  }
}

const RENEW_EVERY_MS = PULL_REQUEST_LIFECYCLE_LEASE_MS / 3;

const lanes = new Map<number, Promise<void>>();
const inSession = new AsyncLocalStorage<number>();

export async function session<T>(
  deps: PrDeps,
  source: PrSource,
  body: (s: PrSession) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const outer = inSession.getStore();
  if (outer !== undefined) throw new Error(`PR session for ${outer} cannot open another`);
  const githubPrId = source.kind === "snapshot" ? source.snapshot.githubPrId : source.githubPrId;
  const run = async ({ session: s, wroteToChannel }: OpenedSession): Promise<T> => {
    let result: T;
    try {
      result = await body(s);
    } catch (error) {
      if (wroteToChannel()) {
        await keepTerminalChannelArchived(deps, githubPrId).catch((err) =>
          deps.logger.warn("re-archive after a failed write did not finish", {
            githubPrId,
            err: errMessage(err),
          }),
        );
      }
      throw error;
    }
    if (wroteToChannel()) await keepTerminalChannelArchived(deps, githubPrId);
    return result;
  };
  return inLane(githubPrId, () =>
    inSession.run(githubPrId, () =>
      leased(deps, githubPrId, signal, async () => {
        if (source.kind === "existing") {
          return run(
            prSession(deps, signal, undefined, {
              ready: () => stored(deps, githubPrId),
              channel: () => storedChannel(deps, githubPrId),
            }),
          );
        }
        let converged: ConvergeOutcome | undefined;
        if (source.cause.kind === "child") await followNewerSnapshot(deps, source.snapshot, signal);
        else converged = await converge(deps, source.snapshot, source.cause);
        const readyPr = () => ready(deps, source.snapshot);
        return run(prSession(deps, signal, converged, { ready: readyPr, channel: readyPr }));
      }),
    ),
  );
}

interface OpenedSession {
  session: PrSession;
  /** Whether the body reached for the channel, so a write may have unarchived it. */
  wroteToChannel(): boolean;
}

/**
 * The gateway answers `is_archived` by unarchiving and retrying, so a late
 * comment, review, or invite on a closed or merged PR reopens its channel.
 * Archive it again before releasing the lease, once Slack confirms it is open.
 * A transient failure retries the job (deliveries are idempotent); anything
 * else is logged, since the write itself already landed.
 */
async function keepTerminalChannelArchived(deps: PrDeps, githubPrId: number): Promise<void> {
  const row = await findByGithubPrId(deps.db, githubPrId);
  const channelId = row?.channelId;
  if (!row || !channelId || !isTerminal(row.currentState)) return;
  if (!row.appliedState || !isTerminal(row.appliedState)) return;
  const fields = { prId: row.id, githubPrId, channelId };
  try {
    if ((await deps.slack.isArchived(channelId)) !== false) return;
    await deps.quietArchive?.(channelId);
    await deps.slack.archive(channelId);
    deps.logger.info("re-archived PR channel after a late write reopened it", fields);
  } catch (err) {
    if (err instanceof Retry || (err instanceof SlackApiError && err.transient)) throw err;
    deps.logger.error("could not re-archive PR channel after a late write", {
      ...fields,
      err: errMessage(err),
    });
  }
}

function prSession(
  deps: PrDeps,
  signal: AbortSignal | undefined,
  converged: ConvergeOutcome | undefined,
  find: { ready: () => Promise<ReadyPr>; channel: () => Promise<ChannelPr> },
): OpenedSession {
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
    state: (key) => ledger.state(key),
    sentTs: (key) => ledger.sentTs(key),
    tombstone: (key) => ledger.tombstone(key),
    inviteMentions: async (body, excludeLogin) =>
      inviteMentions(deps, await s.channel(), body, excludeLogin),
  };
  return { session: s, wroteToChannel: () => channel !== undefined };
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
