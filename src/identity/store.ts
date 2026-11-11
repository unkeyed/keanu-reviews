import { createHash } from "node:crypto";
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
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

export async function findSlackUsersByGithubLogins(
  db: Db,
  githubLogins: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (githubLogins.length === 0) return found;
  const login = sql<string>`lower(${identities.githubLogin})`;
  const rows = await db
    .select({ login, slackUserId: identities.slackUserId })
    .from(identities)
    .where(
      inArray(
        login,
        githubLogins.map((l) => l.toLowerCase()),
      ),
    )
    .orderBy(desc(identities.updatedAt));
  for (const row of rows) if (!found.has(row.login)) found.set(row.login, row.slackUserId);
  return found;
}

export type SelfLinkIdentityResult =
  | { outcome: "linked" | "refreshed"; identity: IdentityRow }
  | { outcome: "conflict" };

async function linkSelfIdentity(
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

const GITHUB_LINK_CONFIRMATION_TTL_MS = 10 * 60_000;

function secretHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

async function consumeNonce(db: Db, nonce: string, expiresAt: Date): Promise<boolean> {
  const consumed = await db
    .insert(oauthStateNonces)
    .values({ nonceHash: secretHash(nonce), expiresAt })
    .onConflictDoNothing({ target: oauthStateNonces.nonceHash })
    .returning({ nonceHash: oauthStateNonces.nonceHash });
  return consumed.length > 0;
}

async function deleteExpiredGithubLinkArtifacts(
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
    await deleteExpiredGithubLinkArtifacts(tx, now);
    if (!(await consumeNonce(tx, input.nonce, input.stateExpiresAt))) {
      return { outcome: "state_replayed" as const };
    }

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
    await deleteExpiredGithubLinkArtifacts(tx, now);

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

    return linkSelfIdentity(tx, {
      githubUserId: pending.githubUserId,
      githubLogin: pending.githubLogin,
      slackUserId: pending.slackUserId,
    });
  });
}

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
    if (!(await consumeNonce(tx, input.nonce, input.stateExpiresAt))) {
      return { outcome: "state_replayed" as const };
    }

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

export async function getSlackUserTokenRows(
  db: Db,
  slackTeamId: string,
  slackUserIds: readonly string[],
): Promise<Map<string, { encryptedToken: string; scopes: string }>> {
  if (slackUserIds.length === 0) return new Map();
  const rows = await db
    .select({
      slackUserId: slackUserTokens.slackUserId,
      encryptedToken: slackUserTokens.encryptedToken,
      scopes: slackUserTokens.scopes,
    })
    .from(slackUserTokens)
    .where(
      and(
        eq(slackUserTokens.slackTeamId, slackTeamId),
        inArray(slackUserTokens.slackUserId, [...slackUserIds]),
      ),
    );
  return new Map(rows.map(({ slackUserId, ...row }) => [slackUserId, row]));
}

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
