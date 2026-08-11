import { and, eq, lte } from "drizzle-orm";
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
      set: { dueAt: input.dueAt, status: "pending" },
    })
    .returning();
  return row as ReminderRow;
}

/** Pending reminders whose time has come. Caller claims each atomically before posting. */
export async function listDue(db: Db, now: Date): Promise<ReminderRow[]> {
  return db
    .select()
    .from(reminders)
    .where(and(eq(reminders.status, "pending"), lte(reminders.dueAt, now)));
}

/**
 * Atomically claim a due reminder (KTD10). The conditional `WHERE status='pending'`
 * means exactly one concurrent caller gets the row back; losers get undefined and
 * must not post. Prevents double-posting across instances / rolling deploys.
 */
export async function claimReminder(db: Db, id: string): Promise<ReminderRow | undefined> {
  const [row] = await db
    .update(reminders)
    .set({ status: "sent" })
    .where(and(eq(reminders.id, id), eq(reminders.status, "pending")))
    .returning();
  return row;
}

export async function cancelForReviewer(
  db: Db,
  prId: string,
  reviewerGithubId: number,
): Promise<void> {
  await db
    .update(reminders)
    .set({ status: "cancelled" })
    .where(
      and(eq(reminders.id, reminderId(prId, reviewerGithubId)), eq(reminders.status, "pending")),
    );
}

export async function cancelForPr(db: Db, prId: string): Promise<void> {
  await db
    .update(reminders)
    .set({ status: "cancelled" })
    .where(and(eq(reminders.prId, prId), eq(reminders.status, "pending")));
}
