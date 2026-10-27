import { and, eq, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type ReviewAlertRow, reviewAlerts } from "../schema.ts";

const alertId = (prId: string, reviewerGithubId: number): string => `${prId}::${reviewerGithubId}`;

export interface ReviewAlertSource {
  sourceUpdatedAt: Date;
  sourceVersion?: string;
}

const normalizedSource = (source: ReviewAlertSource) => ({
  sourceUpdatedAt: source.sourceUpdatedAt,
  sourceVersion: source.sourceVersion ?? "",
});

/** Strict ordering keeps a stale webhook from resurrecting or cancelling an alert. */
const incomingIsNewer = (source: ReviewAlertSource) => {
  const normalized = normalizedSource(source);
  return or(
    lt(reviewAlerts.sourceUpdatedAt, normalized.sourceUpdatedAt),
    and(
      eq(reviewAlerts.sourceUpdatedAt, normalized.sourceUpdatedAt),
      lt(reviewAlerts.sourceVersion, normalized.sourceVersion),
    ),
  );
};

async function findAlert(db: Db, id: string): Promise<ReviewAlertRow | undefined> {
  const [row] = await db.select().from(reviewAlerts).where(eq(reviewAlerts.id, id)).limit(1);
  return row;
}

export interface HoldReviewAlertInput {
  prId: string;
  reviewerGithubId: number;
  reviewerLogin: string;
  effectRef: string;
  sourceUpdatedAt: Date;
  sourceVersion?: string;
}

/**
 * Record that this reviewer was asked to review and has not been notified yet.
 * A newer request re-opens a sent or cancelled row. While the row is already
 * `held`, the Slack effect ref stays put so CI completion and ready_for_review
 * cannot each post their own invite.
 */
export async function holdReviewAlert(
  db: Db,
  input: HoldReviewAlertInput,
): Promise<ReviewAlertRow> {
  const id = alertId(input.prId, input.reviewerGithubId);
  const source = normalizedSource(input);
  const [row] = await db
    .insert(reviewAlerts)
    .values({
      id,
      prId: input.prId,
      reviewerGithubId: input.reviewerGithubId,
      reviewerLogin: input.reviewerLogin,
      effectRef: input.effectRef,
      status: "held",
      ...source,
    })
    .onConflictDoUpdate({
      target: reviewAlerts.id,
      set: {
        reviewerLogin: input.reviewerLogin,
        effectRef: sql`CASE WHEN ${reviewAlerts.status} = 'held' THEN ${reviewAlerts.effectRef} ELSE ${input.effectRef} END`,
        status: "held",
        ...source,
        updatedAt: new Date(),
      },
      setWhere: incomingIsNewer(source),
    })
    .returning();
  if (row) return row;
  const existing = await findAlert(db, id);
  if (!existing) throw new Error(`Review alert upsert returned no row for ${id}`);
  return existing;
}

/** Drop a not-yet-sent alert, and tombstone one that has not been recorded yet. */
export async function cancelReviewAlert(
  db: Db,
  input: {
    prId: string;
    reviewerGithubId: number;
    reviewerLogin?: string;
    sourceUpdatedAt: Date;
    sourceVersion?: string;
  },
): Promise<ReviewAlertRow> {
  const id = alertId(input.prId, input.reviewerGithubId);
  const source = normalizedSource(input);
  const [row] = await db
    .insert(reviewAlerts)
    .values({
      id,
      prId: input.prId,
      reviewerGithubId: input.reviewerGithubId,
      reviewerLogin: input.reviewerLogin ?? "",
      effectRef: "",
      status: "cancelled",
      ...source,
    })
    .onConflictDoUpdate({
      target: reviewAlerts.id,
      set: {
        status: "cancelled",
        ...source,
        updatedAt: new Date(),
      },
      setWhere: incomingIsNewer(source),
    })
    .returning();
  if (row) return row;
  const existing = await findAlert(db, id);
  if (!existing) throw new Error(`Review alert cancellation returned no row for ${id}`);
  return existing;
}

/** Cancel every alert on a PR whose source is older than this close/merge. */
export async function cancelReviewAlertsForPr(
  db: Db,
  prId: string,
  sourceUpdatedAt: Date,
  sourceVersion = "",
): Promise<void> {
  const source = normalizedSource({ sourceUpdatedAt, sourceVersion });
  await db
    .update(reviewAlerts)
    .set({ status: "cancelled", ...source, updatedAt: new Date() })
    .where(and(eq(reviewAlerts.prId, prId), incomingIsNewer(source)));
}

export async function listHeldReviewAlerts(db: Db, prId: string): Promise<ReviewAlertRow[]> {
  return db
    .select()
    .from(reviewAlerts)
    .where(and(eq(reviewAlerts.prId, prId), eq(reviewAlerts.status, "held")));
}

/** Mark a held alert sent. A concurrent cancel or a second releaser matches nothing. */
export async function markReviewAlertSent(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(reviewAlerts)
    .set({ status: "sent", updatedAt: new Date() })
    .where(and(eq(reviewAlerts.id, id), eq(reviewAlerts.status, "held")))
    .returning({ id: reviewAlerts.id });
  return rows.length > 0;
}
