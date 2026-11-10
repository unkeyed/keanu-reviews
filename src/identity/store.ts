import { createHash } from "node:crypto";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import {
  type Db,
  type IdentityRow,
  githubLinkConfirmations,
  identities,
  oauthStateNonces,
  slackUserTokens,
} from "#db";

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

/**
 * Resolve a bare GitHub @-mention login to a linked identity. GitHub logins are
 * case-insensitive, so we match case-folded; if a login was ever reused across
 * ids we prefer the most recently linked row. The identity map is people-sized
 * (one row per linked user), so the case-folded scan is cheap and needs no index.
 */
export async function findByGithubLogin(
  db: Db,
  githubLogin: string,
): Promise<IdentityRow | undefined> {
  const [row] = await db
    .select()
    .from(identities)
    .where(eq(sql`lower(${identities.githubLogin})`, githubLogin.toLowerCase()))
    .orderBy(desc(identities.updatedAt))
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

export const GITHUB_LINK_CONFIRMATION_TTL_MS = 10 * 60_000;

function secretHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export async function deleteExpiredGithubLinkArtifacts(
  db: Db,
  now = new Date(),
): Promise<{ confirmations: number; nonces: number }> {
  const confirmations = await db
    .delete(githubLinkConfirmations)
    .where(lte(githubLinkConfirmations.expiresAt, now))
    .returning({ codeHash: githubLinkConfirmations.codeHash });
  const nonces = await db
    .delete(oauthStateNonces)
    .where(lte(oauthStateNonces.expiresAt, now))
    .returning({ nonceHash: oauthStateNonces.nonceHash });
  return { confirmations: confirmations.length, nonces: nonces.length };
}

export type CreateGithubLinkConfirmationResult =
  | { outcome: "pending"; expiresAt: Date }
  | { outcome: "state_expired" | "state_replayed" };

/** Consume signed OAuth state once and persist a browser-to-Slack confirmation. */
export async function createGithubLinkConfirmation(
  db: Db,
  input: {
    nonce: string;
    stateExpiresAt: Date;
    code: string;
    slackTeamId: string;
    slackUserId: string;
    githubUserId: number;
    githubLogin: string;
    now?: Date;
  },
): Promise<CreateGithubLinkConfirmationResult> {
  const now = input.now ?? new Date();
  if (input.stateExpiresAt.getTime() <= now.getTime()) return { outcome: "state_expired" };
  const confirmationExpiresAt = new Date(
    Math.min(input.stateExpiresAt.getTime(), now.getTime() + GITHUB_LINK_CONFIRMATION_TTL_MS),
  );

  return db.transaction(async (tx) => {
    const transactionDb = tx as unknown as Db;
    await deleteExpiredGithubLinkArtifacts(transactionDb, now);

    const consumed = await tx
      .insert(oauthStateNonces)
      .values({ nonceHash: secretHash(input.nonce), expiresAt: input.stateExpiresAt })
      .onConflictDoNothing({ target: oauthStateNonces.nonceHash })
      .returning({ nonceHash: oauthStateNonces.nonceHash });
    if (consumed.length === 0) return { outcome: "state_replayed" as const };

    // Only the newest completed OAuth flow for a Slack identity remains valid.
    await tx
      .delete(githubLinkConfirmations)
      .where(
        and(
          eq(githubLinkConfirmations.slackTeamId, input.slackTeamId),
          eq(githubLinkConfirmations.slackUserId, input.slackUserId),
        ),
      );
    await tx.insert(githubLinkConfirmations).values({
      codeHash: secretHash(input.code),
      slackTeamId: input.slackTeamId,
      slackUserId: input.slackUserId,
      githubUserId: input.githubUserId,
      githubLogin: input.githubLogin,
      expiresAt: confirmationExpiresAt,
    });
    return { outcome: "pending" as const, expiresAt: confirmationExpiresAt };
  });
}

export type ConfirmGithubLinkResult = SelfLinkIdentityResult | { outcome: "invalid_or_expired" };

/** Atomically bind, consume, and apply one Slack-user-owned confirmation code. */
export async function confirmGithubLink(
  db: Db,
  input: {
    code: string;
    slackTeamId: string;
    slackUserId: string;
    now?: Date;
  },
): Promise<ConfirmGithubLinkResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const transactionDb = tx as unknown as Db;
    await deleteExpiredGithubLinkArtifacts(transactionDb, now);

    const [pending] = await tx
      .delete(githubLinkConfirmations)
      .where(
        and(
          eq(githubLinkConfirmations.codeHash, secretHash(input.code)),
          eq(githubLinkConfirmations.slackTeamId, input.slackTeamId),
          eq(githubLinkConfirmations.slackUserId, input.slackUserId),
          gt(githubLinkConfirmations.expiresAt, now),
        ),
      )
      .returning();
    if (!pending) return { outcome: "invalid_or_expired" as const };

    return linkSelfIdentity(transactionDb, {
      githubUserId: pending.githubUserId,
      githubLogin: pending.githubLogin,
      slackUserId: pending.slackUserId,
    });
  });
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

    await upsertSlackUserToken(tx, {
      slackUserId: input.slackUserId,
      slackTeamId: input.slackTeamId,
      encryptedToken: input.encryptedToken,
      scopes: input.scopes,
      now,
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
