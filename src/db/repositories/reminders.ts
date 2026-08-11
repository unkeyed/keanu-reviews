import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type ReminderRow, reminders } from "../schema.ts";

const reminderId = (prId: string, reviewerGithubId: number): string =>
  `${prId}::${reviewerGithubId}`;

/** Schedule (or reset) a reminder. Re-requesting a review restarts the clock. */
export async function scheduleReminder(
  db: Db,
  input: { prId: string; reviewerGithubId: number; dueAt: Date },
): Promise<ReminderRow> {
  const id = reminderId(input.prId, input.reviewerGithubId);
  const [row] = await db
    .insert(reminders)
    .values({ id, ...input, status: "pending" })
    .onConflictDoUpdate({
      target: reminders.id,
      set: { dueAt: input.dueAt, status: "pending", claimedAt: null },
    })
    .returning();
  return row as ReminderRow;
}

/** Due pending reminders plus sending rows whose worker lease expired. */
export async function listDue(db: Db, now: Date, leaseMs = 5 * 60_000): Promise<ReminderRow[]> {
  const leaseExpiredAt = new Date(now.getTime() - leaseMs);
  return db
    .select()
    .from(reminders)
    .where(
      and(
        lte(reminders.dueAt, now),
        or(
          eq(reminders.status, "pending"),
          and(
            eq(reminders.status, "sending"),
            or(isNull(reminders.claimedAt), lte(reminders.claimedAt, leaseExpiredAt)),
          ),
        ),
      ),
    );
}

/**
 * Atomically claim a due reminder (KTD10). Only pending or expired sending rows
 * can transition to sending, so one concurrent caller gets the row back.
 */
export async function claimReminder(
  db: Db,
  id: string,
  now = new Date(),
  leaseMs = 5 * 60_000,
): Promise<ReminderRow | undefined> {
  const leaseExpiredAt = new Date(now.getTime() - leaseMs);
  const [row] = await db
    .update(reminders)
    .set({ status: "sending", claimedAt: now })
    .where(
      and(
        eq(reminders.id, id),
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
    claim.claimedAt ? eq(reminders.claimedAt, claim.claimedAt) : isNull(reminders.claimedAt),
  );

/** Confirm a cancellation or newer lease has not superseded this claim. */
export async function isReminderClaimCurrent(db: Db, claim: ReminderRow): Promise<boolean> {
  const [row] = await db.select({ id: reminders.id }).from(reminders).where(currentClaim(claim));
  return row !== undefined;
}

/** Mark sent only when the caller still owns the same sending lease. */
export async function markReminderSent(db: Db, claim: ReminderRow): Promise<boolean> {
  const rows = await db
    .update(reminders)
    .set({ status: "sent", claimedAt: null })
    .where(currentClaim(claim))
    .returning({ id: reminders.id });
  return rows.length > 0;
}

/** Release a failed attempt immediately; an expired sending lease is the crash fallback. */
export async function releaseReminderClaim(db: Db, claim: ReminderRow): Promise<void> {
  await db.update(reminders).set({ status: "pending", claimedAt: null }).where(currentClaim(claim));
}

export async function cancelReminderClaim(db: Db, claim: ReminderRow): Promise<void> {
  await db
    .update(reminders)
    .set({ status: "cancelled", claimedAt: null })
    .where(currentClaim(claim));
}

export async function cancelForReviewer(
  db: Db,
  prId: string,
  reviewerGithubId: number,
): Promise<void> {
  await db
    .update(reminders)
    .set({ status: "cancelled", claimedAt: null })
    .where(
      and(
        eq(reminders.id, reminderId(prId, reviewerGithubId)),
        or(eq(reminders.status, "pending"), eq(reminders.status, "sending")),
      ),
    );
}

export async function cancelForPr(db: Db, prId: string): Promise<void> {
  await db
    .update(reminders)
    .set({ status: "cancelled", claimedAt: null })
    .where(
      and(
        eq(reminders.prId, prId),
        or(eq(reminders.status, "pending"), eq(reminders.status, "sending")),
      ),
    );
}
