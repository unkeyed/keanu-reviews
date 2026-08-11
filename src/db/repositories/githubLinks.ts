import { createHash } from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import type { Db } from "../client.ts";
import { githubLinkConfirmations, oauthStateNonces } from "../schema.ts";
import { type SelfLinkIdentityResult, linkSelfIdentity } from "./identities.ts";

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
