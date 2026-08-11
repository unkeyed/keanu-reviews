import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type IdentityRow, identities } from "../schema.ts";

export interface UpsertIdentityInput {
  githubUserId: number;
  githubLogin: string;
  slackUserId: string;
  source: "self-link" | "admin-import" | "email-match";
}

/** Idempotent on githubUserId (KTD6): re-linking updates the row, never duplicates. */
export async function upsertIdentity(db: Db, input: UpsertIdentityInput): Promise<IdentityRow> {
  const [row] = await db
    .insert(identities)
    .values({ ...input, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: identities.githubUserId,
      set: {
        githubLogin: input.githubLogin,
        slackUserId: input.slackUserId,
        source: input.source,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row as IdentityRow;
}

export async function findByGithubId(
  db: Db,
  githubUserId: number,
): Promise<IdentityRow | undefined> {
  const [row] = await db
    .select()
    .from(identities)
    .where(eq(identities.githubUserId, githubUserId))
    .limit(1);
  return row;
}
