import { createHash } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import type { Db } from "../client.ts";
import { oauthStateNonces, slackUserTokens } from "../schema.ts";

function secretHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

/**
 * Persist (or refresh) one participant's encrypted Slack user token. Re-running
 * the OAuth flow overwrites the prior token for that user, so a re-authorized
 * user or a rotated scope set is always the newest row.
 */
export async function upsertSlackUserToken(
  db: Db,
  input: {
    slackUserId: string;
    slackTeamId: string;
    encryptedToken: string;
    scopes: string;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .insert(slackUserTokens)
    .values({
      slackUserId: input.slackUserId,
      slackTeamId: input.slackTeamId,
      encryptedToken: input.encryptedToken,
      scopes: input.scopes,
      updatedAt: now,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: slackUserTokens.slackUserId,
      set: {
        slackTeamId: input.slackTeamId,
        encryptedToken: input.encryptedToken,
        scopes: input.scopes,
        updatedAt: now,
      },
    });
}

export type CompleteSlackTokenAuthorizationResult =
  | { outcome: "stored" }
  | { outcome: "state_expired" | "state_replayed" };

/**
 * Consume the signed OAuth-state nonce exactly once and persist the encrypted
 * token in the same transaction. Mirrors the GitHub flow's replay protection
 * (KTD-style single-use state) so a captured callback URL cannot be replayed to
 * overwrite a token or mint a duplicate.
 */
export async function completeSlackTokenAuthorization(
  db: Db,
  input: {
    nonce: string;
    stateExpiresAt: Date;
    slackUserId: string;
    slackTeamId: string;
    encryptedToken: string;
    scopes: string;
    now?: Date;
  },
): Promise<CompleteSlackTokenAuthorizationResult> {
  const now = input.now ?? new Date();
  if (input.stateExpiresAt.getTime() <= now.getTime()) return { outcome: "state_expired" };

  return db.transaction(async (tx) => {
    await tx.delete(oauthStateNonces).where(lte(oauthStateNonces.expiresAt, now));

    const consumed = await tx
      .insert(oauthStateNonces)
      .values({ nonceHash: secretHash(input.nonce), expiresAt: input.stateExpiresAt })
      .onConflictDoNothing({ target: oauthStateNonces.nonceHash })
      .returning({ nonceHash: oauthStateNonces.nonceHash });
    if (consumed.length === 0) return { outcome: "state_replayed" as const };

    await tx
      .insert(slackUserTokens)
      .values({
        slackUserId: input.slackUserId,
        slackTeamId: input.slackTeamId,
        encryptedToken: input.encryptedToken,
        scopes: input.scopes,
        updatedAt: now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: slackUserTokens.slackUserId,
        set: {
          slackTeamId: input.slackTeamId,
          encryptedToken: input.encryptedToken,
          scopes: input.scopes,
          updatedAt: now,
        },
      });
    return { outcome: "stored" as const };
  });
}

/**
 * The encrypted token + granted scopes for a Slack user in this workspace, if one
 * is stored. Callers decrypt the token and inspect `scopes` to decide which
 * user-token operations (leave, post-as-user) it's actually authorized for.
 */
export async function getSlackUserTokenRow(
  db: Db,
  slackTeamId: string,
  slackUserId: string,
): Promise<{ encryptedToken: string; scopes: string } | undefined> {
  const [row] = await db
    .select({ encryptedToken: slackUserTokens.encryptedToken, scopes: slackUserTokens.scopes })
    .from(slackUserTokens)
    .where(
      and(
        eq(slackUserTokens.slackTeamId, slackTeamId),
        eq(slackUserTokens.slackUserId, slackUserId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Drop a stored token — used when Slack reports it invalid (`token_revoked` /
 * `invalid_auth`) so we don't keep retrying a dead token on every archive.
 */
export async function deleteSlackUserToken(
  db: Db,
  slackTeamId: string,
  slackUserId: string,
): Promise<void> {
  await db
    .delete(slackUserTokens)
    .where(
      and(
        eq(slackUserTokens.slackTeamId, slackTeamId),
        eq(slackUserTokens.slackUserId, slackUserId),
      ),
    );
}
