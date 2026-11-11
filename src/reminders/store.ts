import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { type Db, type ReminderRow, identities, pullRequests, reminders } from "#db";
import type { PrState } from "#events";
import type { PrId } from "#lib";

const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 60_000;

const reminderId = (prId: PrId, reviewerGithubId: number): string => `${prId}::${reviewerGithubId}`;

export interface SourceStamp {
  updatedAt: Date;
  version: string;
}

const stampColumns = (stamp: SourceStamp) => ({
  sourceUpdatedAt: stamp.updatedAt,
  sourceVersion: stamp.version,
});

const incomingIsNewer = (stamp: SourceStamp) =>
  or(
    lt(reminders.sourceUpdatedAt, stamp.updatedAt),
    and(eq(reminders.sourceUpdatedAt, stamp.updatedAt), lt(reminders.sourceVersion, stamp.version)),
  );

async function findReminder(db: Db, id: string): Promise<ReminderRow | undefined> {
  const [row] = await db.select().from(reminders).where(eq(reminders.id, id)).limit(1);
  return row;
}

export async function findReminderForReviewer(
  db: Db,
  prId: PrId,
  reviewerGithubId: number,
): Promise<ReminderRow | undefined> {
  return findReminder(db, reminderId(prId, reviewerGithubId));
}

export async function pushReminderDue(
  db: Db,
  prId: PrId,
  reviewerGithubId: number,
  dueAt: Date,
): Promise<void> {
  await db
    .update(reminders)
    .set({ dueAt, availableAt: dueAt, attempts: 0, claimedAt: null })
    .where(
      and(eq(reminders.id, reminderId(prId, reviewerGithubId)), eq(reminders.status, "pending")),
    );
}

export async function scheduleReminder(
  db: Db,
  input: { prId: PrId; reviewerGithubId: number; dueAt: Date; stamp: SourceStamp },
): Promise<ReminderRow> {
  const id = reminderId(input.prId, input.reviewerGithubId);
  const source = stampColumns(input.stamp);
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
      setWhere: incomingIsNewer(input.stamp),
    })
    .returning();
  if (row) return row;
  const existing = await findReminder(db, id);
  if (!existing) throw new Error(`Reminder upsert returned no row for ${id}`);
  return existing;
}

const claimable = (now: Date) => {
  const leaseExpiredAt = new Date(now.getTime() - LEASE_MS);
  return and(
    lte(reminders.availableAt, now),
    or(
      eq(reminders.status, "pending"),
      and(
        eq(reminders.status, "sending"),
        or(isNull(reminders.claimedAt), lte(reminders.claimedAt, leaseExpiredAt)),
      ),
    ),
  );
};

export interface DuePr {
  githubPrId: number;
  repoFullName: string;
  number: number;
  currentState: PrState;
  channelId: string | null;
  headSha: string | null;
}

export interface DueReminder {
  reminder: ReminderRow;
  pr: DuePr;
  reviewerSlackUserId: string | undefined;
}

export async function listDueWithContext(db: Db, now: Date, limit: number): Promise<DueReminder[]> {
  const rows = await db
    .select({
      reminder: reminders,
      pr: {
        githubPrId: pullRequests.githubPrId,
        repoFullName: pullRequests.repoFullName,
        number: pullRequests.number,
        currentState: pullRequests.currentState,
        channelId: pullRequests.channelId,
        headSha: pullRequests.headSha,
      },
      reviewerSlackUserId: identities.slackUserId,
    })
    .from(reminders)
    .innerJoin(pullRequests, eq(pullRequests.id, reminders.prId))
    .leftJoin(identities, eq(identities.githubUserId, reminders.reviewerGithubId))
    .where(claimable(now))
    .orderBy(asc(reminders.availableAt), asc(reminders.createdAt), asc(reminders.id))
    .limit(limit);
  return rows.map((row) => ({
    reminder: row.reminder,
    pr: row.pr,
    reviewerSlackUserId: row.reviewerSlackUserId ?? undefined,
  }));
}

export async function claimReminder(
  db: Db,
  id: string,
  now: Date,
): Promise<ReminderRow | undefined> {
  const [row] = await db
    .update(reminders)
    .set({
      status: "sending",
      claimedAt: now,
      attempts: sql`${reminders.attempts} + 1`,
    })
    .where(and(eq(reminders.id, id), claimable(now)))
    .returning();
  return row;
}

export async function deferReminder(
  db: Db,
  listed: ReminderRow,
  availableAt: Date,
  now: Date,
): Promise<void> {
  await db
    .update(reminders)
    .set({ status: "pending", claimedAt: null, availableAt })
    .where(
      and(eq(reminders.id, listed.id), eq(reminders.generation, listed.generation), claimable(now)),
    );
}

const currentClaim = (claim: ReminderRow) =>
  and(
    eq(reminders.id, claim.id),
    eq(reminders.status, "sending"),
    eq(reminders.generation, claim.generation),
    eq(reminders.attempts, claim.attempts),
    claim.claimedAt ? eq(reminders.claimedAt, claim.claimedAt) : isNull(reminders.claimedAt),
  );

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

export async function rescheduleOrFailReminder(
  db: Db,
  claim: ReminderRow,
  now: Date,
): Promise<"pending" | "failed" | "superseded"> {
  const terminal = claim.attempts >= MAX_ATTEMPTS;
  const retryAt = new Date(now.getTime() + RETRY_BASE_MS * 2 ** Math.max(0, claim.attempts - 1));
  const rows = await db
    .update(reminders)
    .set(
      terminal
        ? { status: "failed", claimedAt: null }
        : { status: "pending", claimedAt: null, availableAt: retryAt },
    )
    .where(currentClaim(claim))
    .returning({ id: reminders.id });
  if (rows.length === 0) return "superseded";
  return terminal ? "failed" : "pending";
}

export async function restartReminderClaim(db: Db, claim: ReminderRow, dueAt: Date): Promise<void> {
  await db
    .update(reminders)
    .set({ status: "pending", claimedAt: null, dueAt, availableAt: dueAt, attempts: 0 })
    .where(currentClaim(claim));
}

export async function cancelReminderClaim(db: Db, claim: ReminderRow): Promise<void> {
  await db
    .update(reminders)
    .set({ status: "cancelled", claimedAt: null })
    .where(currentClaim(claim));
}

export async function cancelForReviewer(
  db: Db,
  prId: PrId,
  reviewerGithubId: number,
  stamp: SourceStamp,
): Promise<ReminderRow> {
  const id = reminderId(prId, reviewerGithubId);
  const source = stampColumns(stamp);
  const [row] = await db
    .insert(reminders)
    .values({
      id,
      prId,
      reviewerGithubId,
      dueAt: stamp.updatedAt,
      availableAt: stamp.updatedAt,
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
      setWhere: incomingIsNewer(stamp),
    })
    .returning();
  if (row) return row;
  const existing = await findReminder(db, id);
  if (!existing) throw new Error(`Reminder cancellation returned no row for ${id}`);
  return existing;
}

export async function cancelForPr(db: Db, prId: PrId, stamp: SourceStamp): Promise<void> {
  await db
    .update(reminders)
    .set({
      ...stampColumns(stamp),
      status: "cancelled",
      claimedAt: null,
      generation: sql`${reminders.generation} + 1`,
    })
    .where(and(eq(reminders.prId, prId), incomingIsNewer(stamp)));
}
