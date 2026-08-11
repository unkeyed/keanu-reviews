import { asc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type JobRow, jobs } from "../schema.ts";

let seq = 0;
const jobId = (deliveryId: string): string => `${deliveryId}:${Date.now()}:${seq++}`;

export async function enqueueJob(
  db: Db,
  input: { deliveryId: string; event: string; action: string | null; raw: unknown },
): Promise<JobRow> {
  const [row] = await db
    .insert(jobs)
    .values({ id: jobId(input.deliveryId), ...input, status: "pending", attempts: 0 })
    .returning();
  return row as JobRow;
}

/**
 * Claim the oldest pending job for a single worker (KTD10). `FOR UPDATE SKIP
 * LOCKED` inside the transaction means concurrent workers never grab the same
 * row. Returns undefined when the queue is empty.
 */
export async function claimNextJob(db: Db): Promise<JobRow | undefined> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(jobs)
      .where(eq(jobs.status, "pending"))
      .orderBy(asc(jobs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return undefined;
    const [claimed] = await tx
      .update(jobs)
      .set({ status: "processing", claimedAt: new Date(), attempts: candidate.attempts + 1 })
      .where(eq(jobs.id, candidate.id))
      .returning();
    return claimed as JobRow;
  });
}

/** Mark done and purge the raw payload (retention, KTD13). */
export async function completeJob(db: Db, id: string): Promise<void> {
  await db.update(jobs).set({ status: "done", raw: null }).where(eq(jobs.id, id));
}

export async function failJob(db: Db, id: string): Promise<void> {
  await db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, id));
}
