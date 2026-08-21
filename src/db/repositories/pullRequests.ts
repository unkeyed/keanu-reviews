import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import type { PrState } from "../../domain/prState.ts";
import type { Db } from "../client.ts";
import { type PullRequestRow, pullRequestLifecycleClaims, pullRequests } from "../schema.ts";

export const prId = (repoFullName: string, number: number): string => `${repoFullName}#${number}`;

export interface UpsertPrInput {
  repoFullName: string;
  number: number;
  githubPrId: number;
  currentState: PrState;
  headSha?: string | null;
  channelId?: string | null;
  rootMessageTs?: string | null;
  sourceUpdatedAt?: Date | null;
  sourceArrivalKey?: string | null;
}

interface PullRequestSourceInput extends UpsertPrInput {
  sourceUpdatedAt: Date;
}

interface UpsertResult {
  row: PullRequestRow;
  sourceAccepted: boolean;
}

async function upsert(db: Db, input: UpsertPrInput): Promise<UpsertResult> {
  const id = prId(input.repoFullName, input.number);
  const now = new Date();
  const values = {
    id,
    repoFullName: input.repoFullName,
    number: input.number,
    githubPrId: input.githubPrId,
    currentState: input.currentState,
    headSha: input.headSha ?? null,
    channelId: input.channelId ?? null,
    rootMessageTs: input.rootMessageTs ?? null,
    sourceUpdatedAt: input.sourceUpdatedAt ?? null,
    sourceArrivalKey: input.sourceArrivalKey ?? null,
    updatedAt: now,
  };
  const sourceGuard = input.sourceUpdatedAt
    ? input.sourceArrivalKey
      ? or(
          isNull(pullRequests.sourceUpdatedAt),
          lt(pullRequests.sourceUpdatedAt, input.sourceUpdatedAt),
          and(
            eq(pullRequests.sourceUpdatedAt, input.sourceUpdatedAt),
            or(
              isNull(pullRequests.sourceArrivalKey),
              lte(pullRequests.sourceArrivalKey, input.sourceArrivalKey),
            ),
          ),
        )
      : or(
          isNull(pullRequests.sourceUpdatedAt),
          lte(pullRequests.sourceUpdatedAt, input.sourceUpdatedAt),
        )
    : undefined;
  const [row] = await db
    .insert(pullRequests)
    .values(values)
    .onConflictDoUpdate({
      target: pullRequests.githubPrId,
      set: {
        repoFullName: values.repoFullName,
        number: values.number,
        currentState: values.currentState,
        ...(input.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: values.sourceUpdatedAt } : {}),
        ...(input.sourceArrivalKey !== undefined
          ? { sourceArrivalKey: values.sourceArrivalKey }
          : {}),
        // Only overwrite headSha when a new one is supplied (synchronize/opened).
        ...(input.headSha !== undefined ? { headSha: input.headSha } : {}),
        updatedAt: now,
      },
      ...(sourceGuard ? { setWhere: sourceGuard } : {}),
    })
    .returning();
  if (row) return { row: row as PullRequestRow, sourceAccepted: true };

  const existing = await findByGithubPrId(db, input.githubPrId);
  if (!existing) throw new Error(`PR upsert returned no row for GitHub PR ${input.githubPrId}`);
  return { row: existing, sourceAccepted: false };
}

/** Idempotent on GitHub's immutable PR id; preserves the stable internal row id. */
export async function upsertPullRequest(db: Db, input: UpsertPrInput): Promise<PullRequestRow> {
  return (await upsert(db, input)).row;
}

/** Apply a versioned GitHub snapshot, rejecting snapshots older than the stored source version. */
export async function applyPullRequestSource(
  db: Db,
  input: PullRequestSourceInput,
): Promise<UpsertResult> {
  return upsert(db, input);
}

export interface PullRequestLifecycleClaim {
  githubPrId: number;
  claimToken: string;
  claimedAt: Date;
}

/**
 * Acquire a cross-replica lifecycle lease. The random token fences a stale
 * holder from releasing a lease that has since been reclaimed.
 */
export async function claimPullRequestLifecycle(
  db: Db,
  githubPrId: number,
  options: { now?: Date; leaseMs?: number } = {},
): Promise<PullRequestLifecycleClaim | undefined> {
  const now = options.now ?? new Date();
  const leaseExpiredAt = new Date(now.getTime() - (options.leaseMs ?? 5 * 60_000));
  const claimToken = randomUUID();

  const [inserted] = await db
    .insert(pullRequestLifecycleClaims)
    .values({ githubPrId, claimToken, claimedAt: now })
    .onConflictDoNothing({ target: pullRequestLifecycleClaims.githubPrId })
    .returning();
  if (inserted) return inserted;

  const [reclaimed] = await db
    .update(pullRequestLifecycleClaims)
    .set({ claimToken, claimedAt: now })
    .where(
      and(
        eq(pullRequestLifecycleClaims.githubPrId, githubPrId),
        lte(pullRequestLifecycleClaims.claimedAt, leaseExpiredAt),
      ),
    )
    .returning();
  return reclaimed;
}

export async function releasePullRequestLifecycle(
  db: Db,
  claim: PullRequestLifecycleClaim,
): Promise<boolean> {
  const rows = await db
    .delete(pullRequestLifecycleClaims)
    .where(
      and(
        eq(pullRequestLifecycleClaims.githubPrId, claim.githubPrId),
        eq(pullRequestLifecycleClaims.claimToken, claim.claimToken),
      ),
    )
    .returning({ githubPrId: pullRequestLifecycleClaims.githubPrId });
  return rows.length > 0;
}

export async function setChannel(
  db: Db,
  id: string,
  channelId: string,
  rootMessageTs: string | null,
  channelNameVersion?: number,
): Promise<void> {
  await db
    .update(pullRequests)
    .set({
      channelId,
      rootMessageTs,
      // Stamp the naming scheme only when supplied (first channel creation); a
      // later root-post reconciliation must not overwrite an existing version.
      ...(channelNameVersion !== undefined ? { channelNameVersion } : {}),
      updatedAt: new Date(),
    })
    .where(eq(pullRequests.id, id));
}

export async function updateState(db: Db, id: string, state: PrState): Promise<void> {
  await db
    .update(pullRequests)
    .set({ currentState: state, updatedAt: new Date() })
    .where(eq(pullRequests.id, id));
}

/** Record the mergeable_state last announced to the channel (post-on-change gate). */
export async function setMergeableState(db: Db, id: string, state: string): Promise<void> {
  await db
    .update(pullRequests)
    .set({ lastMergeableState: state, updatedAt: new Date() })
    .where(eq(pullRequests.id, id));
}

/**
 * Atomically claim the right to post the one merge comment (opt-in GitHub write).
 * Returns true for exactly one caller; the loser skips. Release on failure so a
 * retry can re-attempt.
 */
export async function claimMergeComment(db: Db, id: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(pullRequests)
    .set({ mergeCommentPostedAt: now })
    .where(and(eq(pullRequests.id, id), isNull(pullRequests.mergeCommentPostedAt)))
    .returning({ id: pullRequests.id });
  return rows.length > 0;
}

export async function releaseMergeComment(db: Db, id: string): Promise<void> {
  await db.update(pullRequests).set({ mergeCommentPostedAt: null }).where(eq(pullRequests.id, id));
}

export async function markSlackStateApplied(
  db: Db,
  id: string,
  state: PrState,
  appliedChannelName: string,
): Promise<void> {
  await db
    .update(pullRequests)
    .set({ appliedState: state, appliedChannelName, updatedAt: new Date() })
    .where(eq(pullRequests.id, id));
}

export async function findByRepoNumber(
  db: Db,
  repoFullName: string,
  number: number,
): Promise<PullRequestRow | undefined> {
  const [row] = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoFullName, repoFullName), eq(pullRequests.number, number)))
    .limit(1);
  return row;
}

/** Resolve repository-scoped PR numbers in caller order with one query. */
export async function findAllByRepoNumbers(
  db: Db,
  repoFullName: string,
  numbers: number[],
): Promise<PullRequestRow[]> {
  if (numbers.length === 0) return [];
  const rows = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoFullName, repoFullName), inArray(pullRequests.number, numbers)));
  const byNumber = new Map(rows.map((row) => [row.number, row]));
  return numbers.flatMap((number) => {
    const row = byNumber.get(number);
    return row ? [row] : [];
  });
}

export async function findByGithubPrId(
  db: Db,
  githubPrId: number,
): Promise<PullRequestRow | undefined> {
  const [row] = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.githubPrId, githubPrId))
    .limit(1);
  return row;
}

export async function findById(db: Db, id: string): Promise<PullRequestRow | undefined> {
  const [row] = await db.select().from(pullRequests).where(eq(pullRequests.id, id)).limit(1);
  return row;
}

/** CI mapping (U7): resolve a repository-scoped head SHA to every tracked PR. */
export async function findAllByRepoHeadSha(
  db: Db,
  repoFullName: string,
  headSha: string,
): Promise<PullRequestRow[]> {
  return db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoFullName, repoFullName), eq(pullRequests.headSha, headSha)));
}
