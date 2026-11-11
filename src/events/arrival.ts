import type { ArrivalKey } from "#lib";

export interface Work {
  arrivalKey: ArrivalKey;
  attempt: number;
  signal: AbortSignal;
}

export function jobArrivalKey(createdAt: Date, jobId: string): ArrivalKey {
  return `${createdAt.toISOString()}:${jobId}` as ArrivalKey;
}

export function reconcileArrivalKey(at: Date): ArrivalKey {
  return `~reconcile:${at.toISOString()}` as ArrivalKey;
}
