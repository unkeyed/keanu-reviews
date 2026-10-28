import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CiReadiness } from "../ci/status.ts";
import type { Db } from "../db/client.ts";
import { upsertIdentity } from "../db/repositories/identities.ts";
import { setChannel, updateState, upsertPullRequest } from "../db/repositories/pullRequests.ts";
import { createTestDb } from "../db/testDb.ts";
import { createLogger } from "../logger.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import { type CheckRunPayload, type ChecksDeps, handleCheckRun } from "./checks.ts";
import { handleReviewRequest } from "./reviewRequest.ts";

let db: Db;
let slack: FakeSlackClient;
let close: () => Promise<void>;
let ci: CiReadiness;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackClient();
  ci = "passing";
});
afterEach(() => close());

const deps = (over: Partial<ChecksDeps> = {}): ChecksDeps => ({
  db,
  slack,
  logger: createLogger("error"),
  fetchCiReadiness: async () => ci,
  fetchPullRequest: async (_repo, number) => ({
    mergeable: false,
    mergeableState: "blocked",
    draft: false,
    requestedReviewers: number === 2 ? [{ id: 8, login: "ada" }] : [{ id: 7, login: "flo" }],
  }),
  ...over,
});

const seedPr = async (
  headSha: string,
  options: {
    repoFullName?: string;
    number?: number;
    channelId?: string;
    currentState?: "draft" | "pr";
  } = {},
) => {
  const row = await upsertPullRequest(db, {
    repoFullName: options.repoFullName ?? "unkey/api",
    number: options.number ?? 1,
    githubPrId: options.number ?? 1,
    currentState: options.currentState ?? "pr",
    headSha,
  });
  await setChannel(db, row.id, options.channelId ?? "C1", "ts-root");
  return row;
};

const requestReview = async (number = 1) => {
  await upsertIdentity(db, {
    githubUserId: 7,
    githubLogin: "flo",
    slackUserId: "U7",
    source: "self-link",
  });
  await handleReviewRequest(deps(), {
    action: "review_requested",
    repository: { full_name: "unkey/api" },
    pull_request: {
      number,
      id: number,
      draft: false,
      merged: false,
      title: "Review me",
      html_url: "https://github.com/unkey/api/pull/1",
      user: { login: "oz", id: 100 },
      head: { sha: "sha-1" },
      updated_at: "2026-08-11T12:00:00Z",
    },
    requested_reviewer: { id: 7, login: "flo" },
  });
};

const payload = (over: Partial<CheckRunPayload["check_run"]> = {}): CheckRunPayload => ({
  action: "completed",
  repository: { full_name: "unkey/api" },
  check_run: {
    id: 100,
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/unkey/api/runs/100",
    head_sha: "sha-1",
    name: "test",
    ...over,
  },
});

describe("CI events release review alerts", () => {
  it("does not post CI or merge status when a check completes", async () => {
    await seedPr("sha-1");
    await handleCheckRun(
      deps({
        fetchPullRequest: async () => ({
          mergeable: true,
          mergeableState: "clean",
          draft: false,
          requestedReviewers: [],
        }),
      }),
      payload(),
    );
    expect(slack.messages).toHaveLength(0);
    expect(JSON.stringify(slack.messages)).not.toContain("Ready to merge");
    expect(JSON.stringify(slack.messages)).not.toContain("checks are failing");
  });

  it("does nothing while the run is still in progress", async () => {
    await seedPr("sha-1");
    ci = "failing";
    await requestReview();
    expect(slack.invites).toHaveLength(0);
    await handleCheckRun(deps(), payload({ status: "in_progress", conclusion: null }));
    expect(slack.invites).toHaveLength(0);
  });

  it("alerts once when CI goes from failing to passing, and not again", async () => {
    await seedPr("sha-1");
    ci = "failing";
    await requestReview();
    expect(slack.invites).toHaveLength(0);
    expect(slack.messages).toHaveLength(0);

    ci = "passing";
    await handleCheckRun(deps(), payload());
    await handleCheckRun(deps(), payload({ id: 101 }));
    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["U7"] }]);
    expect(slack.messages).toHaveLength(1);
    expect(JSON.stringify(slack.messages)).not.toContain("Ready to merge");
    expect(JSON.stringify(slack.messages)).not.toContain("checks are failing");
  });

  it("does not alert on a passing check while the PR is still a draft", async () => {
    await seedPr("sha-1", { currentState: "draft" });
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    ci = "failing";
    await handleReviewRequest(deps(), {
      action: "review_requested",
      repository: { full_name: "unkey/api" },
      pull_request: {
        number: 1,
        id: 1,
        draft: true,
        title: "Review me",
        html_url: "https://github.com/unkey/api/pull/1",
        user: { login: "oz", id: 100 },
        head: { sha: "sha-1" },
        updated_at: "2026-08-11T12:00:00Z",
      },
      requested_reviewer: { id: 7, login: "flo" },
    });
    ci = "passing";
    await handleCheckRun(deps(), payload());
    expect(slack.invites).toHaveLength(0);

    await updateState(db, "unkey/api#1", "pr");
    await handleCheckRun(deps(), payload({ id: 102 }));
    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["U7"] }]);
  });

  it("stays quiet when a later check is for a stale head SHA", async () => {
    await seedPr("sha-2");
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    ci = "failing";
    await handleReviewRequest(
      deps(),
      {
        action: "review_requested",
        repository: { full_name: "unkey/api" },
        pull_request: {
          number: 1,
          id: 1,
          draft: false,
          title: "Review me",
          html_url: "https://github.com/unkey/api/pull/1",
          user: { login: "oz", id: 100 },
          head: { sha: "sha-2" },
          updated_at: "2026-08-11T12:00:00Z",
        },
        requested_reviewer: { id: 7, login: "flo" },
      },
      "delivery-1",
      "delivery-1",
    );
    ci = "passing";
    await handleCheckRun(deps(), payload({ head_sha: "sha-1" }));
    expect(slack.invites).toHaveLength(0);
    await handleCheckRun(deps(), payload({ id: 103, head_sha: "sha-2" }));
    expect(slack.invites).toHaveLength(1);
  });

  it("routes by repository and alerts every associated tracked PR that is held", async () => {
    await seedPr("sha-1", { repoFullName: "other/api", channelId: "C-other" });
    await seedPr("sha-1", { number: 1, channelId: "C1" });
    await seedPr("sha-1", { number: 2, channelId: "C2" });
    ci = "failing";
    await requestReview(1);
    await upsertIdentity(db, {
      githubUserId: 8,
      githubLogin: "ada",
      slackUserId: "U8",
      source: "self-link",
    });
    await handleReviewRequest(deps(), {
      action: "review_requested",
      repository: { full_name: "unkey/api" },
      pull_request: {
        number: 2,
        id: 2,
        draft: false,
        title: "Review me",
        html_url: "https://github.com/unkey/api/pull/2",
        user: { login: "oz", id: 100 },
        head: { sha: "sha-1" },
        updated_at: "2026-08-11T12:00:00Z",
      },
      requested_reviewer: { id: 8, login: "ada" },
    });
    ci = "passing";
    await handleCheckRun(deps(), payload({ pull_requests: [{ number: 1 }, { number: 2 }] }));
    expect(slack.invites.map((invite) => invite.channelId).sort()).toEqual(["C1", "C2"]);
  });

  it("falls back to REST when head_sha isn't stored, then ignores if unresolved", async () => {
    await seedPr("stored-sha");
    ci = "failing";
    await requestReview();
    // The held alert is for sha-1, which is not the stored head, so a fallback
    // that finds PR 1 still must not alert on the stale SHA.
    const fetchPrForSha = vi.fn(async () => [1]);
    ci = "passing";
    await handleCheckRun(deps({ fetchPrForSha }), payload({ head_sha: "fork-sha" }));
    expect(fetchPrForSha).toHaveBeenCalled();
    expect(slack.invites).toHaveLength(0);

    const misses = vi.fn(async () => []);
    await handleCheckRun(deps({ fetchPrForSha: misses }), payload({ head_sha: "unknown" }));
    expect(slack.messages).toHaveLength(0);
  });

  it("retries when GitHub associates a PR whose local mapping is not ready", async () => {
    await expect(
      handleCheckRun(deps(), payload({ pull_requests: [{ number: 99 }] })),
    ).rejects.toThrow("PR channel is not ready");
  });

  it("alerts mapped associations before retrying a missing one", async () => {
    await seedPr("sha-1", { number: 1, channelId: "C1" });
    ci = "failing";
    await requestReview();
    ci = "passing";
    const event = payload({ pull_requests: [{ number: 1 }, { number: 2 }] });
    await expect(handleCheckRun(deps(), event)).rejects.toThrow("PR channel is not ready");
    expect(slack.invites.map((invite) => invite.channelId)).toEqual(["C1"]);
  });

  it("does not alert when the aggregate is still failing or pending", async () => {
    await seedPr("sha-1");
    ci = "failing";
    await requestReview();
    await handleCheckRun(deps(), payload({ conclusion: "failure" }));
    ci = "pending";
    await handleCheckRun(deps(), payload({ id: 101, conclusion: "success" }));
    expect(slack.invites).toHaveLength(0);
  });
});
