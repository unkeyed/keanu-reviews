import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type MessageRow, messages } from "../schema.ts";

export interface MessageEffectInput {
  prId: string;
  kind: string;
  githubEventRef: string;
}

/** Collision-safe, durable identity for one externally visible Slack effect. */
export function messageNaturalKey(input: MessageEffectInput): string {
  return [input.prId, input.kind, input.githubEventRef]
    .map((part) => `${part.length}:${part}`)
    .join("|");
}

/** Slack requires a UUID-shaped client_msg_id. Derive one from the natural key. */
export function messageClientMsgId(naturalKey: string): string {
  const bytes = Buffer.from(createHash("sha256").update(naturalKey).digest().subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Claim a pending message effect, or reclaim one whose sending lease expired.
 * A sent effect and a currently-owned sending effect both return undefined.
 */
export async function claimMessageEffect(
  db: Db,
  input: MessageEffectInput,
  options: { now?: Date; leaseMs?: number } = {},
): Promise<MessageRow | undefined> {
  const naturalKey = messageNaturalKey(input);
  const now = options.now ?? new Date();
  // Match the job lease so a reclaimed job can also reclaim an abandoned
  // Slack effect instead of exhausting retries behind a longer inner lease.
  const leaseExpiredAt = new Date(now.getTime() - (options.leaseMs ?? 60_000));

  await db
    .insert(messages)
    .values({
      id: randomUUID(),
      naturalKey,
      ...input,
      clientMsgId: messageClientMsgId(naturalKey),
      status: "pending",
    })
    .onConflictDoNothing({ target: messages.naturalKey });

  const [claimed] = await db
    .update(messages)
    .set({ status: "sending", claimedAt: now })
    .where(
      and(
        eq(messages.naturalKey, naturalKey),
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

const currentClaim = (claim: MessageRow) =>
  and(
    eq(messages.id, claim.id),
    eq(messages.status, "sending"),
    claim.claimedAt ? eq(messages.claimedAt, claim.claimedAt) : isNull(messages.claimedAt),
  );

export async function completeMessageEffect(
  db: Db,
  claim: MessageRow,
  slackTs: string,
): Promise<boolean> {
  const rows = await db
    .update(messages)
    .set({ status: "sent", slackTs, claimedAt: null })
    .where(currentClaim(claim))
    .returning({ id: messages.id });
  return rows.length > 0;
}

/** Known failures are immediately retryable; lease expiry covers process crashes. */
export async function releaseMessageEffect(db: Db, claim: MessageRow): Promise<void> {
  await db.update(messages).set({ status: "pending", claimedAt: null }).where(currentClaim(claim));
}

export async function findMessageEffect(
  db: Db,
  input: MessageEffectInput,
): Promise<MessageRow | undefined> {
  const [row] = await db
    .select()
    .from(messages)
    .where(eq(messages.naturalKey, messageNaturalKey(input)))
    .limit(1);
  return row;
}

export async function findRootTs(db: Db, prId: string): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.prId, prId), eq(messages.kind, "root"), eq(messages.status, "sent")))
    .limit(1);
  return row?.slackTs ?? undefined;
}
