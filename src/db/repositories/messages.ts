import { and, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { messages } from "../schema.ts";

let seq = 0;

/**
 * Record a posted Slack message, keyed to its PR + kind + source event so a
 * replayed webhook does not post twice (idempotency, KTD4). Returns true when a
 * new row was written (i.e. the caller should post), false when already recorded.
 */
export async function recordMessage(
  db: Db,
  input: { prId: string; kind: string; githubEventRef: string | null; slackTs: string },
): Promise<boolean> {
  const inserted = await db
    .insert(messages)
    .values({ id: `${input.prId}:${input.kind}:${seq++}`, ...input })
    .onConflictDoNothing({
      target: [messages.prId, messages.kind, messages.githubEventRef],
    })
    .returning();
  return inserted.length > 0;
}

export async function findRootTs(db: Db, prId: string): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.prId, prId), eq(messages.kind, "root")))
    .limit(1);
  return row?.slackTs;
}
