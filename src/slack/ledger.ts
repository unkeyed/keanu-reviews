import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { type Db, type MessageRow, messages } from "#db";
import { type ClientMsgId, type Clock, Retry, leaseWaitMs, systemClock } from "#lib";
import { type EffectKey, type Message, render } from "./catalog.ts";
import { BOT, type Poster, type RenderedMessage, type SlackGateway } from "./gateway.ts";

// The worker's default job lease is 60 seconds. Keep an in-flight external
// effect fenced beyond that boundary so a reclaimed job cannot post it twice.
export const MESSAGE_LEASE_MS = 2 * 60_000;

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
  const leaseExpiredAt = new Date(now.getTime() - leaseMs);

  await db
    .insert(messages)
    .values({
      id: randomUUID(),
      naturalKey: natural,
      prId: key.prId,
      kind: key.kind,
      githubEventRef: key.ref,
      clientMsgId: clientMsgId(natural),
      status: "pending",
    })
    .onConflictDoNothing({ target: messages.naturalKey });

  const [claimed] = await db
    .update(messages)
    .set({ status: "sending", claimedAt: now })
    .where(
      and(
        eq(messages.naturalKey, natural),
        or(
          eq(messages.status, "pending"),
          and(
            eq(messages.status, "sending"),
            or(isNull(messages.claimedAt), lte(messages.claimedAt, leaseExpiredAt)),
          ),
        ),
      ),
    )
    .returning();
  return claimed as MessageRow | undefined;
}

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
export async function release(db: Db, row: MessageRow): Promise<void> {
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

/** A build that can return null may also come back `skipped`. */
export type Delivered<B extends Outgoing | null = Outgoing | null> = B extends null
  ? { status: "skipped" }
  : Sent;

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
  /** The Slack ts of an effect that was sent, else undefined. */
  sentTs(key: EffectKey): Promise<string | undefined>;
}

const sentTsOf = (row: MessageRow | undefined) =>
  row?.status === "sent" && row.slackTs ? row.slackTs : undefined;

export function createLedger(db: Db, clock: Clock = systemClock): Ledger {
  const deliver = async (
    key: EffectKey,
    sink: ChannelSink,
    build: () => Promise<Outgoing | null>,
    opts: DeliverOptions = {},
  ): Promise<Delivered> => {
    const already = sentTsOf(await find(db, key));
    if (already) return { status: "already-sent", ts: already };

    const out = await build();
    if (!out) return { status: "skipped" };

    const row = await claim(db, key, clock.now());
    if (!row) {
      const existing = await find(db, key);
      const ts = sentTsOf(existing);
      if (ts) return { status: "already-sent", ts };
      throw new Retry(
        `Slack effect is already being delivered: ${key.kind}`,
        { kind: key.kind },
        leaseWaitMs(existing?.claimedAt, MESSAGE_LEASE_MS, clock.now()),
      );
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
    async sentTs(key) {
      return sentTsOf(await find(db, key));
    },
  };
}
