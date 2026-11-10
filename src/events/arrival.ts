import type { ArrivalKey } from "#lib";

/** A webhook job's arrival order: `${createdAt ISO}:${jobId}`. */
export function jobArrivalKey(createdAt: Date, jobId: string): ArrivalKey {
  return `${createdAt.toISOString()}:${jobId}` as ArrivalKey;
}

/**
 * The daily reconcile's key. `~` sorts after the digits that start every job
 * key, so a reconcile snapshot with the same updated_at still wins.
 */
export function reconcileArrivalKey(at: Date): ArrivalKey {
  return `~reconcile:${at.toISOString()}` as ArrivalKey;
}
