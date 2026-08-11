import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type ReminderRow, reminders } from "../schema.ts";

const reminderId = (prId: string, reviewerGithubId: number): string =>
  `${prId}::${reviewerGithubId}`;

export interface ReminderSource {
  sourceUpdatedAt: Date;
  sourceVersion?: string;
}

const normalizedSource = (source: ReminderSource) => ({
  sourceUpdatedAt: source.sourceUpdatedAt,
  sourceVersion: source.sourceVersion ?? "",
});

/** Strict ordering keeps duplicate or stale source events from changing a tombstone. */
const incomingIsNewer = (source: ReminderSource) => {
  const normalized = normalizedSource(source);
  return or(
    lt(reminders.sourceUpdatedAt, normalized.sourceUpdatedAt),
    and(
      eq(reminders.sourceUpdatedAt, normalized.sourceUpdatedAt),
      lt(reminders.sourceVersion, normalized.sourceVersion),
    ),
  );
};

async function findReminder(db: Db, id: string): Promise<ReminderRow | undefined> {
  const [row] = await db.select().from(reminders).where(eq(reminders.id, id)).limit(1);
  return row;
}

/** Schedule a new generation only when its source version is newer than stored state. */
export async function scheduleReminder(
  db: Db,
  input: {
    prId: string;
    reviewerGithubId: number;
    dueAt: Date;
    sourceUpdatedAt?: Date;
    sourceVersion?: string;
  },
): Promise<ReminderRow> {
  const id = reminderId(input.prId, input.reviewerGithubId);
  const source = normalizedSource({
    sourceUpdatedAt: input.sourceUpdatedAt ?? new Date(0),
    sourceVersion: input.sourceVersion,
  });
  const [row] = await db
    .insert(reminders)
    .values({
      id,
      prId: input.prId,
      reviewerGithubId: input.reviewerGithubId,
      dueAt: input.dueAt,
      availableAt: input.dueAt,
      ...source,
      status: "pending",
      attempts: 0,
      generation: 1,
    })
    .onConflictDoUpdate({
      target: reminders.id,
      set: {
        dueAt: input.dueAt,
        availableAt: input.dueAt,
        ...source,
        status: "pending",
        attempts: 0,
        claimedAt: null,
        generation: sql`${reminders.generation} + 1`,
      },
      setWhere: incomingIsNewer(source),
    })
    .returning();
  if (row) return row;
  const existing = await findReminder(db, id);
  if (!existing) throw new Error(`Reminder upsert returned no row for ${id}`);
  return existing;
}

/** Due pending reminders plus sending rows whose worker lease expired, in a bounded order. */
export async function listDue(
  db: Db,
  now: Date,
  leaseMs = 5 * 60_000,
  batchSize = 50,
): Promise<ReminderRow[]> {
  const leaseExpiredAt = new Date(now.getTime() - leaseMs);
  return db
    .select()
    .from(reminders)
    .where(
      and(
        lte(reminders.availableAt, now),
        or(
          eq(reminders.status, "pending"),
          and(
            eq(reminders.status, "sending"),
            or(isNull(reminders.claimedAt), lte(reminders.claimedAt, leaseExpiredAt)),
          ),
        ),
      ),
    )
    .orderBy(asc(reminders.availableAt), asc(reminders.createdAt), asc(reminders.id))
    .limit(batchSize);
}

/** Atomically claim a due reminder and record this delivery attempt. */
export async function claimReminder(
  db: Db,
  id: string,
  now = new Date(),
  leaseMs = 5 * 60_000,
): Promise<ReminderRow | undefined> {
  const leaseExpiredAt = new Date(now.getTime() - leaseMs);
  const [row] = await db
    .update(reminders)
    .set({
      status: "sending",
      claimedAt: now,
      attempts: sql`${reminders.attempts} + 1`,
    })
    .where(
      and(
        eq(reminders.id, id),
        lte(reminders.availableAt, now),
        or(
          eq(reminders.status, "pending"),
          and(
            eq(reminders.status, "sending"),
            or(isNull(reminders.claimedAt), lte(reminders.claimedAt, leaseExpiredAt)),
          ),
        ),
      ),
    )
    .returning();
  return row;
}

const currentClaim = (claim: ReminderRow) =>
  and(
    eq(reminders.id, claim.id),
    eq(reminders.status, "sending"),
    eq(reminders.generation, claim.generation),
    eq(reminders.attempts, claim.attempts),
    claim.claimedAt ? eq(reminders.claimedAt, claim.claimedAt) : isNull(reminders.claimedAt),
  );

/** Confirm a cancellation or newer generation has not superseded this claim. */
export async function isReminderClaimCurrent(db: Db, claim: ReminderRow): Promise<boolean> {
  const [row] = await db.select({ id: reminders.id }).from(reminders).where(currentClaim(claim));
  return row !== undefined;
}

export async function markReminderSent(db: Db, claim: ReminderRow): Promise<boolean> {
  const rows = await db
    .update(reminders)
    .set({ status: "sent", claimedAt: null })
    .where(currentClaim(claim))
    .returning({ id: reminders.id });
  return rows.length > 0;
}

/** Reschedule one failed attempt, or terminally fail it after the retry budget. */
export async function rescheduleOrFailReminder(
  db: Db,
  claim: ReminderRow,
  options: { maxAttempts: number; retryAt: Date },
): Promise<"pending" | "failed" | "superseded"> {
  const terminal = claim.attempts >= options.maxAttempts;
  const rows = await db
    .update(reminders)
    .set(
      terminal
        ? { status: "failed", claimedAt: null }
        : { status: "pending", claimedAt: null, availableAt: options.retryAt },
    )
    .where(currentClaim(claim))
    .returning({ id: reminders.id });
  if (rows.length === 0) return "superseded";
  return terminal ? "failed" : "pending";
}

/** Release without backoff for non-delivery control flow. */
export async function releaseReminderClaim(db: Db, claim: ReminderRow): Promise<void> {
  await db.update(reminders).set({ status: "pending", claimedAt: null }).where(currentClaim(claim));
}

export async function cancelReminderClaim(db: Db, claim: ReminderRow): Promise<void> {
  await db
    .update(reminders)
    .set({ status: "cancelled", claimedAt: null })
    .where(currentClaim(claim));
}

/** Persist a cancellation even when the corresponding request has not arrived yet. */
export async function cancelForReviewer(
  db: Db,
  prId: string,
  reviewerGithubId: number,
  sourceUpdatedAt = new Date(),
  sourceVersion = "",
): Promise<ReminderRow> {
  const id = reminderId(prId, reviewerGithubId);
  const source = normalizedSource({ sourceUpdatedAt, sourceVersion });
  const [row] = await db
    .insert(reminders)
    .values({
      id,
      prId,
      reviewerGithubId,
      dueAt: sourceUpdatedAt,
      availableAt: sourceUpdatedAt,
      ...source,
      status: "cancelled",
      attempts: 0,
      generation: 1,
    })
    .onConflictDoUpdate({
      target: reminders.id,
      set: {
        ...source,
        status: "cancelled",
        claimedAt: null,
        generation: sql`${reminders.generation} + 1`,
      },
      setWhere: incomingIsNewer(source),
    })
    .returning();
  if (row) return row;
  const existing = await findReminder(db, id);
  if (!existing) throw new Error(`Reminder cancellation returned no row for ${id}`);
  return existing;
}

export async function cancelForPr(
  db: Db,
  prId: string,
  sourceUpdatedAt = new Date(),
  sourceVersion = "",
): Promise<void> {
  const source = normalizedSource({ sourceUpdatedAt, sourceVersion });
  await db
    .update(reminders)
    .set({
      ...source,
      status: "cancelled",
      claimedAt: null,
      generation: sql`${reminders.generation} + 1`,
    })
    .where(and(eq(reminders.prId, prId), incomingIsNewer(source)));
}
