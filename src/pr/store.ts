import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm";
import { type Db, type PullRequestRow, pullRequestLifecycleClaims, pullRequests } from "#db";
import type { PrState } from "#events";
import type { ArrivalKey, PrId } from "#lib";

export const prId = (repoFullName: string, number: number): PrId =>
  `${repoFullName}#${number}` as PrId;

/** A pull_requests row whose id is known to be a PrId. */
export type PrRow = Omit<PullRequestRow, "id"> & { id: PrId };

export interface PrSourceInput {
  repoFullName: string;
  number: number;
  githubPrId: number;
  currentState: PrState;
  headSha?: string | null;
  channelId?: string | null;
  rootMessageTs?: string | null;
  sourceUpdatedAt?: Date | null;
  sourceArrivalKey?: ArrivalKey | null;
}

interface SourceResult {
  row: PrRow;
  sourceAccepted: boolean;
}

/**
 * Apply a versioned GitHub snapshot, rejecting one older than the stored source
 * version. Idempotent on GitHub's immutable PR id; preserves the stable row id.
 */
export async function applyPullRequestSource(db: Db, input: PrSourceInput): Promise<SourceResult> {
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
  if (row) return { row: row as PrRow, sourceAccepted: true };

  const existing = await findByGithubPrId(db, input.githubPrId);
  if (!existing) throw new Error(`PR upsert returned no row for GitHub PR ${input.githubPrId}`);
  return { row: existing, sourceAccepted: false };
}

export const PULL_REQUEST_LIFECYCLE_LEASE_MS = 5 * 60_000;

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
  const leaseExpiredAt = new Date(
    now.getTime() - (options.leaseMs ?? PULL_REQUEST_LIFECYCLE_LEASE_MS),
  );
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

/** When the current holder claimed a PR's lifecycle, if anyone holds it. */
export async function pullRequestLifecycleClaimedAt(
  db: Db,
  githubPrId: number,
): Promise<Date | undefined> {
  const [held] = await db
    .select({ claimedAt: pullRequestLifecycleClaims.claimedAt })
    .from(pullRequestLifecycleClaims)
    .where(eq(pullRequestLifecycleClaims.githubPrId, githubPrId));
  return held?.claimedAt;
}

/** Restart a held lease's clock. False once another holder has taken the lease over. */
export async function renewPullRequestLifecycle(
  db: Db,
  claim: PullRequestLifecycleClaim,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(pullRequestLifecycleClaims)
    .set({ claimedAt: now })
    .where(
      and(
        eq(pullRequestLifecycleClaims.githubPrId, claim.githubPrId),
        eq(pullRequestLifecycleClaims.claimToken, claim.claimToken),
      ),
    )
    .returning({ githubPrId: pullRequestLifecycleClaims.githubPrId });
  return rows.length > 0;
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

/**
 * Delete lifecycle claims nobody renewed since `before`. A live holder renews
 * every 100 seconds and releases its claim when done, so a claim this old was
 * left by a crash. Any claimer could already take it over; this only stops
 * such rows piling up.
 */
export async function deleteLifecycleClaimsBefore(db: Db, before: Date): Promise<number> {
  const rows = await db
    .delete(pullRequestLifecycleClaims)
    .where(lt(pullRequestLifecycleClaims.claimedAt, before))
    .returning({ githubPrId: pullRequestLifecycleClaims.githubPrId });
  return rows.length;
}

export async function setChannel(
  db: Db,
  id: PrId,
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

/**
 * Atomically claim the right to post the one merge comment (opt-in GitHub write).
 * Returns true for exactly one caller; the loser skips. Release on failure so a
 * retry can re-attempt.
 */
export async function claimMergeComment(db: Db, id: PrId, now: Date): Promise<boolean> {
  const rows = await db
    .update(pullRequests)
    .set({ mergeCommentPostedAt: now })
    .where(and(eq(pullRequests.id, id), isNull(pullRequests.mergeCommentPostedAt)))
    .returning({ id: pullRequests.id });
  return rows.length > 0;
}

export async function releaseMergeComment(db: Db, id: PrId): Promise<void> {
  await db.update(pullRequests).set({ mergeCommentPostedAt: null }).where(eq(pullRequests.id, id));
}

export async function markSlackStateApplied(
  db: Db,
  id: PrId,
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
): Promise<PrRow | undefined> {
  const [row] = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoFullName, repoFullName), eq(pullRequests.number, number)))
    .limit(1);
  return row as PrRow | undefined;
}

/** Resolve repository-scoped PR numbers in caller order with one query. */
export async function findAllByRepoNumbers(
  db: Db,
  repoFullName: string,
  numbers: number[],
): Promise<PrRow[]> {
  if (numbers.length === 0) return [];
  const rows = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoFullName, repoFullName), inArray(pullRequests.number, numbers)));
  const byNumber = new Map((rows as PrRow[]).map((row) => [row.number, row]));
  return numbers.flatMap((number) => {
    const row = byNumber.get(number);
    return row ? [row] : [];
  });
}

export async function findByGithubPrId(db: Db, githubPrId: number): Promise<PrRow | undefined> {
  const [row] = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.githubPrId, githubPrId))
    .limit(1);
  return row as PrRow | undefined;
}

export async function findById(db: Db, id: string): Promise<PrRow | undefined> {
  const [row] = await db.select().from(pullRequests).where(eq(pullRequests.id, id)).limit(1);
  return row as PrRow | undefined;
}

/**
 * PRs the app still treats as open: database state is draft or pr, and the Slack
 * channel has not been archived (applied state is missing or non-terminal).
 * A row the database already marks closed or merged is omitted — reconciliation
 * does not touch it again.
 */
export async function listOpenPullRequestsForReconciliation(db: Db): Promise<PrRow[]> {
  const rows = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        inArray(pullRequests.currentState, ["draft", "pr"]),
        or(
          isNull(pullRequests.appliedState),
          and(ne(pullRequests.appliedState, "closed"), ne(pullRequests.appliedState, "merged")),
        ),
      ),
    )
    .orderBy(asc(pullRequests.repoFullName), asc(pullRequests.number));
  return rows as PrRow[];
}

/** The most terminal PRs one re-archive sweep checks. */
const RE_ARCHIVE_LIMIT = 500;

/**
 * Recently closed/merged PRs that still have a channel, for the re-archive sweep.
 * A late write (CI/comment/review) can unarchive a terminal PR's channel via the
 * Slack client's `is_archived` recovery; this bounds the sweep to PRs that went
 * terminal since `since`, where such drift happens, instead of all history.
 */
export async function listRecentlyClosedPullRequests(db: Db, since: Date): Promise<PrRow[]> {
  const rows = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        inArray(pullRequests.currentState, ["closed", "merged"]),
        isNotNull(pullRequests.channelId),
        isNotNull(pullRequests.sourceUpdatedAt),
        gte(pullRequests.sourceUpdatedAt, since),
      ),
    )
    .orderBy(desc(pullRequests.sourceUpdatedAt))
    .limit(RE_ARCHIVE_LIMIT);
  return rows as PrRow[];
}

/** CI mapping (U7): resolve a repository-scoped head SHA to every tracked PR. */
export async function findAllByRepoHeadSha(
  db: Db,
  repoFullName: string,
  headSha: string,
): Promise<PrRow[]> {
  const rows = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoFullName, repoFullName), eq(pullRequests.headSha, headSha)));
  return rows as PrRow[];
}
