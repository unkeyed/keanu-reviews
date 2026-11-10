import { eq } from "drizzle-orm";
import { type Db, pullRequests } from "#db";
import type { PrState } from "#events";

/** Move a seeded PR to a state without a GitHub event, as a stale or racing row would be. */
export async function setPrState(db: Db, id: string, state: PrState): Promise<void> {
  await db
    .update(pullRequests)
    .set({ currentState: state, updatedAt: new Date() })
    .where(eq(pullRequests.id, id));
}
