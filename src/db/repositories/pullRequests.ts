import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type PullRequestRow, pullRequests } from "../schema.ts";

export const prId = (repoFullName: string, number: number): string => `${repoFullName}#${number}`;

export interface UpsertPrInput {
  repoFullName: string;
  number: number;
  githubPrId: number;
  currentState: "draft" | "pr" | "closed" | "merged";
  headSha?: string | null;
  channelId?: string | null;
  rootMessageTs?: string | null;
}

/** Idempotent on (repo, number): a second upsert updates the row, never duplicates. */
export async function upsertPullRequest(db: Db, input: UpsertPrInput): Promise<PullRequestRow> {
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
    updatedAt: now,
  };
  const [row] = await db
    .insert(pullRequests)
    .values(values)
    .onConflictDoUpdate({
      target: pullRequests.id,
      set: {
        githubPrId: values.githubPrId,
        currentState: values.currentState,
        // Only overwrite headSha when a new one is supplied (synchronize/opened).
        ...(input.headSha !== undefined ? { headSha: input.headSha } : {}),
        updatedAt: now,
      },
    })
    .returning();
  return row as PullRequestRow;
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

export async function updateState(
  db: Db,
  id: string,
  state: "draft" | "pr" | "closed" | "merged",
): Promise<void> {
  await db
    .update(pullRequests)
    .set({ currentState: state, updatedAt: new Date() })
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
    .where(eq(pullRequests.id, prId(repoFullName, number)))
    .limit(1);
  return row;
}

export async function findById(db: Db, id: string): Promise<PullRequestRow | undefined> {
  const [row] = await db.select().from(pullRequests).where(eq(pullRequests.id, id)).limit(1);
  return row;
}

/** CI mapping (U7): resolve a check's head_sha to its tracked PR. */
export async function findByHeadSha(db: Db, headSha: string): Promise<PullRequestRow | undefined> {
  const [row] = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.headSha, headSha))
    .limit(1);
  return row;
}
