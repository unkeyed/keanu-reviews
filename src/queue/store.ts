import { and, asc, eq, isNotNull, isNull, lt, lte, notExists, or, sql } from "drizzle-orm";
import { type Db, type JobRow, jobs, processedDeliveries } from "#db";

/** A claimed job not renewed for this long can be claimed by another worker. */
export const LEASE_MS = 60_000;

export interface JobInput {
  deliveryId: string;
  event: string;
  action: string | null;
  raw: unknown;
}

/**
 * Reserve a GitHub delivery id and persist its durable job in one statement:
 * the job row is inserted only from the marker row the same statement created,
 * so a duplicate delivery inserts neither.
 */
export async function enqueueDeliveryJob(
  db: Db,
  input: JobInput,
): Promise<{ isNew: true; job: JobRow } | { isNew: false }> {
  const marker = db
    .$with("marker")
    .as(
      db
        .insert(processedDeliveries)
        .values({ deliveryId: input.deliveryId })
        .onConflictDoNothing({ target: processedDeliveries.deliveryId })
        .returning({ deliveryId: processedDeliveries.deliveryId }),
    );
  const [job] = await db
    .with(marker)
    .insert(jobs)
    .select((qb) =>
      qb
        .select({
          id: marker.deliveryId,
          deliveryId: marker.deliveryId,
          event: sql`${input.event}::text`.as("event"),
          action: sql`${input.action}::text`.as("action"),
          raw: sql`${JSON.stringify(input.raw)}::jsonb`.as("raw"),
          status: sql`'pending'::job_status`.as("status"),
          attempts: sql`0`.as("attempts"),
          claimedAt: sql`null::timestamptz`.as("claimed_at"),
          availableAt: sql`now()`.as("available_at"),
          createdAt: sql`now()`.as("created_at"),
        })
        .from(marker),
    )
    .returning();
  return job ? { isNew: true, job: job as JobRow } : { isNew: false };
}

/**
 * Claim the next due job in one statement: the oldest pending job whose time
 * has come, or a processing job whose lease expired, ordered by available_at
 * then created_at. `SKIP LOCKED` means concurrent workers never claim the same
 * row. Each claim counts an attempt. Undefined when nothing is due.
 */
export async function claimNextJob(db: Db): Promise<JobRow | undefined> {
  const now = new Date();
  const leaseExpiredAt = new Date(now.getTime() - LEASE_MS);
  const next = db
    .select({ id: jobs.id })
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
  const [claimed] = await db
    .update(jobs)
    .set({ status: "processing", claimedAt: now, attempts: sql`${jobs.attempts} + 1` })
    .where(eq(jobs.id, next))
    .returning();
  return claimed as JobRow | undefined;
}

const currentClaim = (job: JobRow) =>
  and(
    eq(jobs.id, job.id),
    eq(jobs.status, "processing"),
    eq(jobs.attempts, job.attempts),
    job.claimedAt ? eq(jobs.claimedAt, job.claimedAt) : isNull(jobs.claimedAt),
  );

/** Extend a running job's lease. Undefined means another worker now holds it. */
export async function renewJobLease(db: Db, job: JobRow, now: Date): Promise<JobRow | undefined> {
  const rows = await db
    .update(jobs)
    .set({ claimedAt: now })
    .where(currentClaim(job))
    .returning({ id: jobs.id });
  return rows.length > 0 ? { ...job, claimedAt: now } : undefined;
}

/** Mark done and purge the raw payload (retention, KTD13). False when the claim was lost. */
export async function completeJob(db: Db, job: JobRow): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ status: "done", raw: null, claimedAt: null })
    .where(currentClaim(job))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

export async function failJob(db: Db, job: JobRow): Promise<void> {
  await db
    .update(jobs)
    // Retain terminal failures for an explicit, targeted admin replay.
    // Successful completion remains the raw-payload purge boundary.
    .set({ status: "failed", claimedAt: null })
    .where(currentClaim(job));
}

export async function rescheduleJob(db: Db, job: JobRow, retryAt: Date): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "pending", claimedAt: null, availableAt: retryAt })
    .where(currentClaim(job));
}

/** Reset one terminal failed job only when its replay payload is still present. */
export async function resetFailedJob(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ status: "pending", attempts: 0, claimedAt: null, availableAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.status, "failed"), isNotNull(jobs.raw)))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/**
 * Delete completed jobs and delivery markers older than `before`. Failed jobs
 * stay for admin replay, and so does the marker of any job still stored, since
 * dropping it would let a GitHub redelivery collide with that job's row.
 */
export async function pruneJobHistory(
  db: Db,
  before: Date,
): Promise<{ jobs: number; deliveries: number }> {
  // A done job's available_at is when its final attempt became due, so this
  // range scans jobs_status_created_idx.
  const deletedJobs = await db
    .delete(jobs)
    .where(and(eq(jobs.status, "done"), lt(jobs.availableAt, before)))
    .returning({ id: jobs.id });
  const deletedDeliveries = await db
    .delete(processedDeliveries)
    .where(
      and(
        lt(processedDeliveries.seenAt, before),
        notExists(
          db
            .select({ id: jobs.id })
            .from(jobs)
            .where(eq(jobs.deliveryId, processedDeliveries.deliveryId)),
        ),
      ),
    )
    .returning({ deliveryId: processedDeliveries.deliveryId });
  return { jobs: deletedJobs.length, deliveries: deletedDeliveries.length };
}
