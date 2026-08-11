import { and, eq } from "drizzle-orm";
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

export type SelfLinkIdentityResult =
  | { outcome: "linked" | "refreshed"; identity: IdentityRow }
  | { outcome: "conflict" };

/**
 * Link an OAuth-verified GitHub identity without ever transferring ownership
 * from another Slack user. The conflict insert plus Slack-scoped update makes
 * the decision safe when two callbacks race for the same GitHub id.
 */
export async function linkSelfIdentity(
  db: Db,
  input: Omit<UpsertIdentityInput, "source">,
): Promise<SelfLinkIdentityResult> {
  const [inserted] = await db
    .insert(identities)
    .values({ ...input, source: "self-link", updatedAt: new Date() })
    .onConflictDoNothing({ target: identities.githubUserId })
    .returning();
  if (inserted) return { outcome: "linked", identity: inserted };

  const [refreshed] = await db
    .update(identities)
    .set({ githubLogin: input.githubLogin, source: "self-link", updatedAt: new Date() })
    .where(
      and(
        eq(identities.githubUserId, input.githubUserId),
        eq(identities.slackUserId, input.slackUserId),
      ),
    )
    .returning();
  if (refreshed) return { outcome: "refreshed", identity: refreshed };
  return { outcome: "conflict" };
}
