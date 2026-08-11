import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { PrState } from "../../domain/prState.ts";
import type { Db } from "../client.ts";
import { type PullRequestRow, pullRequests } from "../schema.ts";

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
    updatedAt: now,
  };
  const sourceGuard = input.sourceUpdatedAt
    ? or(
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

export async function setChannel(
  db: Db,
  id: string,
  channelId: string,
  rootMessageTs: string | null,
): Promise<void> {
  await db
    .update(pullRequests)
    .set({ channelId, rootMessageTs, updatedAt: new Date() })
    .where(eq(pullRequests.id, id));
}

export async function updateState(db: Db, id: string, state: PrState): Promise<void> {
  await db
    .update(pullRequests)
    .set({ currentState: state, updatedAt: new Date() })
    .where(eq(pullRequests.id, id));
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
