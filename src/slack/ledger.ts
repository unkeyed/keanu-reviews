import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { type Db, type MessageRow, messages } from "#db";
import { type ClientMsgId, type Clock, Retry, leaseWaitMs, systemClock } from "#lib";
import { type EffectKey, type Message, render } from "./catalog.ts";
import { BOT, type Poster, type RenderedMessage, type SlackGateway } from "./gateway.ts";

// The worker's default job lease is 60 seconds. Keep an in-flight external
// effect fenced beyond that boundary so a reclaimed job cannot post it twice.
const MESSAGE_LEASE_MS = 2 * 60_000;

/** Collision-safe natural key: `len:prId|len:kind|len:ref`. */
export function naturalKey(key: EffectKey): string {
  return [key.prId, key.kind, key.ref].map((part) => `${part.length}:${part}`).join("|");
}

/** Slack requires a UUID-shaped client_msg_id. Derive one from the natural key. */
export function clientMsgId(natural: string): ClientMsgId {
  const bytes = Buffer.from(createHash("sha256").update(natural).digest().subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ClientMsgId;
}

/**
 * Claim a pending effect, or reclaim one whose sending lease expired. A sent
 * effect and a currently-owned sending effect both return undefined.
 */
export async function claim(
  db: Db,
  key: EffectKey,
  now: Date,
  leaseMs = MESSAGE_LEASE_MS,
): Promise<MessageRow | undefined> {
  const natural = naturalKey(key);
  await db
    .insert(messages)
    .values({ ...newEffect(key, natural), status: "pending" })
    .onConflictDoNothing({ target: messages.naturalKey });

  const [claimed] = await db
    .update(messages)
    .set({ status: "sending", claimedAt: now })
    .where(claimable(natural, now, leaseMs))
    .returning();
  return claimed as MessageRow | undefined;
}

/** A `messages` row for `key`, without its status. */
const newEffect = (key: EffectKey, natural: string) => ({
  id: randomUUID(),
  naturalKey: natural,
  prId: key.prId,
  kind: key.kind,
  githubEventRef: key.ref,
  clientMsgId: clientMsgId(natural),
});

/** Pending, or sending under a lease that expired. */
const claimable = (natural: string, now: Date, leaseMs: number) =>
  and(
    eq(messages.naturalKey, natural),
    or(
      eq(messages.status, "pending"),
      and(
        eq(messages.status, "sending"),
        or(isNull(messages.claimedAt), lte(messages.claimedAt, new Date(now.getTime() - leaseMs))),
      ),
    ),
  );

const currentClaim = (row: MessageRow) =>
  and(
    eq(messages.id, row.id),
    eq(messages.status, "sending"),
    row.claimedAt ? eq(messages.claimedAt, row.claimedAt) : isNull(messages.claimedAt),
  );

/** Mark the claim sent. False when the lease was lost; then nothing in `onSentTx` commits. */
export async function complete(
  db: Db,
  row: MessageRow,
  slackTs: string,
  onSentTx?: (tx: Db) => Promise<void>,
): Promise<boolean> {
  const markSent = async (conn: Db) =>
    (
      await conn
        .update(messages)
        .set({ status: "sent", slackTs, claimedAt: null })
        .where(currentClaim(row))
        .returning({ id: messages.id })
    ).length > 0;
  if (!onSentTx) return markSent(db);
  return db.transaction(async (tx) => {
    const conn = tx as unknown as Db;
    if (!(await markSent(conn))) return false;
    await onSentTx(conn);
    return true;
  });
}

/** Known failures are immediately retryable; lease expiry covers process crashes. */
async function release(db: Db, row: MessageRow): Promise<void> {
  await db.update(messages).set({ status: "pending", claimedAt: null }).where(currentClaim(row));
}

async function find(db: Db, key: EffectKey): Promise<MessageRow | undefined> {
  const [row] = await db
    .select()
    .from(messages)
    .where(eq(messages.naturalKey, naturalKey(key)))
    .limit(1);
  return row;
}

export interface ChannelSink {
  readonly channel: string;
  post(
    msg: RenderedMessage,
    opts: { poster: Poster; threadTs?: string; clientMsgId: ClientMsgId },
  ): Promise<string>;
}

export function channelSink(slack: Pick<SlackGateway, "post">, channel: string): ChannelSink {
  return { channel, post: (msg, opts) => slack.post(channel, msg, opts) };
}

export interface Outgoing {
  message: Message;
  poster?: Poster;
  threadTs?: string;
  /** Runs after the claim and before the post, e.g. inviting the person the message is about. */
  beforePost?: () => Promise<void>;
}

export type Sent = { status: "posted" | "already-sent"; ts: string };

/**
 * A build that can return null may also come back `skipped`. A tombstoned
 * effect was withdrawn before it posted (its comment was deleted) and never
 * posts.
 */
export type Delivered<B extends Outgoing | null = Outgoing | null> =
  | (B extends null ? { status: "skipped" } : Sent)
  | { status: "tombstoned" };

export interface DeliverOptions {
  /** A dependent write committed in the same transaction that marks the effect sent. */
  onSentTx?: (tx: Db) => Promise<void>;
}

/**
 * Durable, exactly-once-per-key Slack delivery; the only writer of `messages`.
 * An effect already sent returns without calling `build`, so redeliveries skip
 * enrichment. `build` returning null posts nothing and leaves no row. The row
 * is marked sent only after Slack returns a timestamp; a crash or an ambiguous
 * failure retries with the same client_msg_id so Slack can deduplicate.
 */
export interface Ledger {
  deliver<B extends Outgoing | null>(
    key: EffectKey,
    sink: ChannelSink,
    build: () => Promise<B>,
    opts?: DeliverOptions,
  ): Promise<Delivered<B>>;
  state(key: EffectKey): Promise<EffectState>;
  /** The Slack ts of an effect that was sent, else undefined. */
  sentTs(key: EffectKey): Promise<string | undefined>;
  /**
   * Withdraw an effect: one already posted returns its ts for the caller to
   * delete; any other is written `sent` with no ts, so it never posts. An
   * effect another holder is sending right now asks for a retry.
   */
  tombstone(key: EffectKey): Promise<string | undefined>;
}

/**
 * Where an effect stands: never claimed, claimed but not yet posted (pending
 * or sending), posted, or withdrawn before it posted.
 */
export type EffectState =
  | { status: "none" | "in-flight" | "tombstoned" }
  | { status: "sent"; ts: string };

/** `sent` with no ts is a tombstone. */
function stateOf(row: MessageRow | undefined): EffectState {
  if (!row) return { status: "none" };
  if (row.status !== "sent") return { status: "in-flight" };
  return row.slackTs ? { status: "sent", ts: row.slackTs } : { status: "tombstoned" };
}

const sentTsOf = (row: MessageRow | undefined) => {
  const state = stateOf(row);
  return state.status === "sent" ? state.ts : undefined;
};

/** A sent or tombstoned effect never posts again. */
function settled(state: EffectState): Delivered | undefined {
  if (state.status === "sent") return { status: "already-sent", ts: state.ts };
  if (state.status === "tombstoned") return { status: "tombstoned" };
  return undefined;
}

const busy = (key: EffectKey, row: MessageRow | undefined, now: Date) =>
  new Retry(
    `Slack effect is already being delivered: ${key.kind}`,
    { kind: key.kind },
    leaseWaitMs(row?.claimedAt, MESSAGE_LEASE_MS, now),
  );

export function createLedger(db: Db, clock: Clock = systemClock): Ledger {
  const deliver = async (
    key: EffectKey,
    sink: ChannelSink,
    build: () => Promise<Outgoing | null>,
    opts: DeliverOptions = {},
  ): Promise<Delivered> => {
    const before = settled(stateOf(await find(db, key)));
    if (before) return before;

    const out = await build();
    if (!out) return { status: "skipped" };

    const row = await claim(db, key, clock.now());
    if (!row) {
      const existing = await find(db, key);
      const after = settled(stateOf(existing));
      if (after) return after;
      throw busy(key, existing, clock.now());
    }

    try {
      await out.beforePost?.();
      const ts = await sink.post(render(out.message), {
        poster: out.poster ?? BOT,
        threadTs: out.threadTs,
        // The column only ever holds clientMsgId(naturalKey) from the insert above.
        clientMsgId: row.clientMsgId as ClientMsgId,
      });
      if (!(await complete(db, row, ts, opts.onSentTx))) {
        throw new Error(`Slack effect lease was lost before completion: ${key.kind}`);
      }
      return { status: "posted", ts };
    } catch (error) {
      await release(db, row);
      throw error;
    }
  };
  return {
    deliver: deliver as Ledger["deliver"],
    async state(key) {
      return stateOf(await find(db, key));
    },
    async sentTs(key) {
      return sentTsOf(await find(db, key));
    },
    async tombstone(key) {
      const natural = naturalKey(key);
      const tombstone = { status: "sent" as const, slackTs: null, claimedAt: null };
      const [inserted] = await db
        .insert(messages)
        .values({ ...newEffect(key, natural), ...tombstone })
        .onConflictDoNothing({ target: messages.naturalKey })
        .returning({ id: messages.id });
      if (inserted) return undefined;
      const now = clock.now();
      const [withdrawn] = await db
        .update(messages)
        .set(tombstone)
        .where(claimable(natural, now, MESSAGE_LEASE_MS))
        .returning({ id: messages.id });
      if (withdrawn) return undefined;
      const row = await find(db, key);
      if (row?.status === "sent") return sentTsOf(row);
      throw busy(key, row, now);
    },
  };
}
