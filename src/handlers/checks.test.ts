import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { setChannel, upsertPullRequest } from "../db/repositories/pullRequests.ts";
import { createTestDb } from "../db/testDb.ts";
import { createLogger } from "../logger.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import { type CheckRunPayload, type ChecksDeps, handleCheckRun } from "./checks.ts";
import type { PullRequestMergeability } from "./mergeability.ts";

let db: Db;
let slack: FakeSlackClient;
let close: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackClient();
});
afterEach(() => close());

const clean: PullRequestMergeability = { mergeable: true, mergeableState: "clean", draft: false };
const deps = (over: Partial<ChecksDeps> = {}): ChecksDeps => ({
  db,
  slack,
  logger: createLogger("error"),
  fetchPullRequest: vi.fn(async () => clean),
  ...over,
});

const seedPr = async (
  headSha: string,
  options: { repoFullName?: string; number?: number; channelId?: string } = {},
) => {
  const row = await upsertPullRequest(db, {
    repoFullName: options.repoFullName ?? "unkey/api",
    number: options.number ?? 1,
    githubPrId: options.number ?? 1,
    currentState: "pr",
    headSha,
  });
  await setChannel(db, row.id, options.channelId ?? "C1", "ts-root");
};

const payload = (over: Partial<CheckRunPayload["check_run"]> = {}): CheckRunPayload => ({
  action: "completed",
  repository: { full_name: "unkey/api" },
  check_run: {
    id: 100,
    status: "completed",
    conclusion: "failure",
    html_url: "https://github.com/unkey/api/runs/100",
    head_sha: "sha-1",
    name: "test",
    ...over,
  },
});

describe("handleCheckRun -> mergeability (R6)", () => {
  it("reports the PR's mergeability, mapped by head_sha", async () => {
    await seedPr("sha-1");
    await handleCheckRun(deps(), payload());
    expect(JSON.stringify(slack.messages.at(-1)?.blocks)).toContain("Ready to merge");
  });

  it("does nothing while the run is still in_progress", async () => {
    await seedPr("sha-1");
    await handleCheckRun(deps(), payload({ status: "in_progress", conclusion: null }));
    expect(slack.messages).toHaveLength(0);
  });

  it("does not re-post when mergeability is unchanged", async () => {
    await seedPr("sha-1");
    await handleCheckRun(deps(), payload());
    await handleCheckRun(deps(), payload({ id: 101 }));
    expect(slack.messages).toHaveLength(1);
  });

  it("routes by repository and reports every associated tracked PR", async () => {
    await seedPr("sha-1", { repoFullName: "other/api", channelId: "C-other" });
    await seedPr("sha-1", { number: 1, channelId: "C1" });
    await seedPr("sha-1", { number: 2, channelId: "C2" });

    await handleCheckRun(deps(), payload({ pull_requests: [{ number: 1 }, { number: 2 }] }));

    expect(slack.messages.map((m) => m.channel).sort()).toEqual(["C1", "C2"]);
  });

  it("falls back to REST when head_sha isn't stored, then ignores if unresolved", async () => {
    await seedPr("stored-sha");
    const fetchPrForSha = vi.fn(async () => [1]);
    await handleCheckRun(deps({ fetchPrForSha }), payload({ head_sha: "fork-sha" }));
    expect(fetchPrForSha).toHaveBeenCalled();
    expect(slack.messages).toHaveLength(1);
  });

  it("ignores a check whose head_sha maps to no tracked PR", async () => {
    const fetchPrForSha = vi.fn(async () => []);
    await handleCheckRun(deps({ fetchPrForSha }), payload({ head_sha: "unknown" }));
    expect(slack.messages).toHaveLength(0);
  });

  it("retries when GitHub associates a PR whose local mapping is not ready", async () => {
    await expect(
      handleCheckRun(deps(), payload({ pull_requests: [{ number: 99 }] })),
    ).rejects.toThrow("PR channel is not ready");
  });

  it("reports mapped associations before retrying a missing one", async () => {
    await seedPr("sha-1", { number: 1, channelId: "C1" });
    const event = payload({ pull_requests: [{ number: 1 }, { number: 2 }] });

    await expect(handleCheckRun(deps(), event)).rejects.toThrow("PR channel is not ready");
    expect(slack.messages.map((m) => m.channel)).toEqual(["C1"]);
  });
});
