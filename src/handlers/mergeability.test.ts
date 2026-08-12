import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import {
  findByRepoNumber,
  setChannel,
  setMergeableState,
  upsertPullRequest,
} from "../db/repositories/pullRequests.ts";
import type { PullRequestRow } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { createLogger } from "../logger.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import { type PullRequestMergeability, reportMergeability } from "./mergeability.ts";

let db: Db;
let slack: FakeSlackClient;
let close: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackClient();
  const row = await upsertPullRequest(db, {
    repoFullName: "unkey/api",
    number: 1,
    githubPrId: 1,
    currentState: "pr",
  });
  await setChannel(db, row.id, "C1", "ts-root");
});
afterEach(() => close());

const row = async (): Promise<PullRequestRow> => {
  const r = await findByRepoNumber(db, "unkey/api", 1);
  if (!r) throw new Error("missing");
  return r;
};

const deps = (m: PullRequestMergeability) => ({
  db,
  slack,
  logger: createLogger("error"),
  fetchPullRequest: vi.fn(async () => m),
});

const state = (s: string, mergeable: boolean | null = true): PullRequestMergeability => ({
  mergeable,
  mergeableState: s,
  draft: false,
});

describe("reportMergeability", () => {
  it.each([
    ["clean", "Ready to merge"],
    ["blocked", "Blocked"],
    ["dirty", "Merge conflicts"],
    ["behind", "Behind the base branch"],
    ["unstable", "some checks are failing"],
  ])("posts the %s state as a channel message", async (s, expected) => {
    await reportMergeability(deps(state(s)), await row(), "evt-1");
    expect(JSON.stringify(slack.messages.at(-1)?.blocks)).toContain(expected);
    expect(slack.messages.at(-1)?.threadTs).toBeUndefined(); // direct channel post
  });

  it("stays quiet when the mergeability is unchanged", async () => {
    await setMergeableState(db, (await row()).id, "clean");
    await reportMergeability(deps(state("clean")), await row(), "evt-1");
    expect(slack.messages).toHaveLength(0);
  });

  it("retries until GitHub finishes computing mergeability", async () => {
    await expect(
      reportMergeability(deps(state("unknown", null)), await row(), "evt-1"),
    ).rejects.toThrow("mergeability not computed");
  });

  it("skips draft PRs", async () => {
    await reportMergeability(
      deps({ mergeable: null, mergeableState: "draft", draft: true }),
      await row(),
      "evt-1",
    );
    expect(slack.messages).toHaveLength(0);
  });

  it("does nothing when no PR fetcher is configured", async () => {
    await reportMergeability({ db, slack, logger: createLogger("error") }, await row(), "evt-1");
    expect(slack.messages).toHaveLength(0);
  });

  it("posts again when the state changes back after flipping", async () => {
    await reportMergeability(deps(state("clean")), await row(), "evt-1");
    await reportMergeability(deps(state("blocked")), await row(), "evt-2");
    await reportMergeability(deps(state("clean")), await row(), "evt-3");
    expect(slack.messages).toHaveLength(3); // clean -> blocked -> clean all announced
  });
});
