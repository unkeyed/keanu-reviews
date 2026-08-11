import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type JobRow, jobs, processedDeliveries } from "../schema.ts";

export interface JobInput {
  deliveryId: string;
  event: string;
  action: string | null;
  raw: unknown;
}

export async function enqueueJob(db: Db, input: JobInput): Promise<JobRow> {
  const [row] = await db
    .insert(jobs)
    .values({ id: randomUUID(), ...input, status: "pending", attempts: 0 })
    .returning();
  return row as JobRow;
}

/** Atomically reserve a GitHub delivery id and persist its durable job. */
export async function enqueueDeliveryJob(
  db: Db,
  input: JobInput,
): Promise<{ isNew: boolean; job?: JobRow }> {
  return db.transaction(async (tx) => {
    const marker = await tx
      .insert(processedDeliveries)
      .values({ deliveryId: input.deliveryId })
      .onConflictDoNothing({ target: processedDeliveries.deliveryId })
      .returning();
    if (marker.length === 0) return { isNew: false };

    const [job] = await tx
      .insert(jobs)
      .values({ id: input.deliveryId, ...input, status: "pending", attempts: 0 })
      .returning();
    return { isNew: true, job: job as JobRow };
  });
}

/**
 * Claim the oldest pending job for a single worker (KTD10). `FOR UPDATE SKIP
 * LOCKED` inside the transaction means concurrent workers never grab the same
 * row. Returns undefined when the queue is empty.
 */
export async function claimNextJob(
  db: Db,
  options: { now?: Date; leaseMs?: number } = {},
): Promise<JobRow | undefined> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? 60_000;
  const leaseExpiredAt = new Date(now.getTime() - leaseMs);
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(jobs)
      .where(
        or(
          and(eq(jobs.status, "pending"), lte(jobs.availableAt, now)),
          and(
            eq(jobs.status, "processing"),
            or(isNull(jobs.claimedAt), lte(jobs.claimedAt, leaseExpiredAt)),
          ),
        ),
      )
      .orderBy(asc(jobs.availableAt), asc(jobs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return undefined;
    const [claimed] = await tx
      .update(jobs)
      .set({ status: "processing", claimedAt: now, attempts: candidate.attempts + 1 })
      .where(eq(jobs.id, candidate.id))
      .returning();
    return claimed as JobRow;
  });
}

const currentClaim = (job: JobRow) =>
  and(
    eq(jobs.id, job.id),
    eq(jobs.status, "processing"),
    eq(jobs.attempts, job.attempts),
    job.claimedAt ? eq(jobs.claimedAt, job.claimedAt) : isNull(jobs.claimedAt),
  );

/** Mark done and purge the raw payload (retention, KTD13). */
export async function completeJob(db: Db, job: JobRow): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ status: "done", raw: null, claimedAt: null })
    .where(currentClaim(job))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

export async function rescheduleOrFailJob(
  db: Db,
  job: JobRow,
  options: { maxAttempts: number; retryAt: Date },
): Promise<"pending" | "failed"> {
  if (job.attempts >= options.maxAttempts) {
    await db
      .update(jobs)
      // Retain terminal failures for an explicit, targeted admin replay.
      // Successful completion remains the raw-payload purge boundary.
      .set({ status: "failed", claimedAt: null })
      .where(currentClaim(job));
    return "failed";
  }

  await db
    .update(jobs)
    .set({ status: "pending", claimedAt: null, availableAt: options.retryAt })
    .where(currentClaim(job));
  return "pending";
}

/** Reset one terminal failed job only when its replay payload is still present. */
export async function resetFailedJob(
  db: Db,
  id: string,
  availableAt = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ status: "pending", attempts: 0, claimedAt: null, availableAt })
    .where(and(eq(jobs.id, id), eq(jobs.status, "failed"), isNotNull(jobs.raw)))
    .returning({ id: jobs.id });
  return rows.length > 0;
}
