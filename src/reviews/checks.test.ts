import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "#app";
import { type CheckRunEvent, jobArrivalKey, parseEvent } from "#events";
import { upsertIdentity } from "#identity";
import type { Db } from "../db/client.ts";
import { createTestDb } from "../db/testDb.ts";
import type { CiReadiness } from "../github/ci.ts";
import { applyPullRequestSource, setChannel } from "../pr/store.ts";
import { handlerDeps } from "../testing/deps.ts";
import { type CheckRunPayload, checkRunEvent, pullRequestEvent } from "../testing/events.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
import { inSession, setPrState } from "../testing/pr.ts";
import { onPullRequest } from "./alerts.ts";
import { onCheckRun } from "./checks.ts";

const onPr = inSession(onPullRequest);
let jobs = 0;
const work = () => ({
  arrivalKey: jobArrivalKey(new Date(0), `job-${String(++jobs).padStart(4, "0")}`),
  attempt: 1,
  signal: new AbortController().signal,
});
const handleCheckRun = (deps: HandlerDeps, ev: CheckRunEvent) => onCheckRun(deps, ev, work());
const handleReviewRequest = (deps: HandlerDeps, ev: Parameters<typeof onPr>[1]) =>
  onPr(deps, ev, work());

let db: Db;
let slack: FakeSlackGateway;
let close: () => Promise<void>;
let ci: CiReadiness;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackGateway();
  ci = "passing";
});
afterEach(() => close());

const deps = (over: Partial<HandlerDeps> = {}) =>
  handlerDeps(db, slack, {
    fetchCiReadiness: async () => ci,
    fetchPullRequest: async (_repo, number) => ({
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
  const row = (
    await applyPullRequestSource(db, {
      repoFullName: options.repoFullName ?? "unkey/api",
      number: options.number ?? 1,
      githubPrId: options.number ?? 1,
      currentState: options.currentState ?? "pr",
      headSha,
    })
  ).row;
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
  await handleReviewRequest(
    deps(),
    pullRequestEvent({
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
    }),
  );
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
          mergeableState: "clean",
          draft: false,
          requestedReviewers: [],
        }),
      }),
      checkRunEvent(payload()),
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
    const ev = parseEvent("check_run", payload({ status: "in_progress", conclusion: null }));
    expect(ev).toMatchObject({ kind: "ignored", reason: "check run not completed" });
    expect(slack.invites).toHaveLength(0);
  });

  it("alerts once when CI goes from failing to passing, and not again", async () => {
    await seedPr("sha-1");
    ci = "failing";
    await requestReview();
    expect(slack.invites).toHaveLength(0);
    expect(slack.messages).toHaveLength(0);

    ci = "passing";
    await handleCheckRun(deps(), checkRunEvent(payload()));
    await handleCheckRun(deps(), checkRunEvent(payload({ id: 101 })));
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
    await handleReviewRequest(
      deps(),
      pullRequestEvent({
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
      }),
    );
    ci = "passing";
    await handleCheckRun(deps(), checkRunEvent(payload()));
    expect(slack.invites).toHaveLength(0);

    await setPrState(db, "unkey/api#1", "pr");
    await handleCheckRun(deps(), checkRunEvent(payload({ id: 102 })));
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
      pullRequestEvent({
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
      }),
    );
    ci = "passing";
    await handleCheckRun(deps(), checkRunEvent(payload({ head_sha: "sha-1" })));
    expect(slack.invites).toHaveLength(0);
    await handleCheckRun(deps(), checkRunEvent(payload({ id: 103, head_sha: "sha-2" })));
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
    await handleReviewRequest(
      deps(),
      pullRequestEvent({
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
      }),
    );
    ci = "passing";
    await handleCheckRun(
      deps(),
      checkRunEvent(payload({ pull_requests: [{ number: 1 }, { number: 2 }] })),
    );
    expect(slack.invites.map((invite) => invite.channelId).sort()).toEqual(["C1", "C2"]);
  });

  it("falls back to REST when head_sha isn't stored, then ignores if unresolved", async () => {
    await seedPr("stored-sha");
    ci = "failing";
    await requestReview();
    const fetchPrForSha = vi.fn(async () => [1]);
    ci = "passing";
    await handleCheckRun(deps({ fetchPrForSha }), checkRunEvent(payload({ head_sha: "fork-sha" })));
    expect(fetchPrForSha).toHaveBeenCalled();
    expect(slack.invites).toHaveLength(0);

    const misses = vi.fn(async () => []);
    await handleCheckRun(
      deps({ fetchPrForSha: misses }),
      checkRunEvent(payload({ head_sha: "unknown" })),
    );
    expect(slack.messages).toHaveLength(0);
  });

  it("retries when GitHub associates a PR whose local mapping is not ready", async () => {
    await expect(
      handleCheckRun(deps(), checkRunEvent(payload({ pull_requests: [{ number: 99 }] }))),
    ).rejects.toThrow("PR channel is not ready");
  });

  it("alerts mapped associations before retrying a missing one", async () => {
    await seedPr("sha-1", { number: 1, channelId: "C1" });
    ci = "failing";
    await requestReview();
    ci = "passing";
    const event = payload({ pull_requests: [{ number: 1 }, { number: 2 }] });
    await expect(handleCheckRun(deps(), checkRunEvent(event))).rejects.toThrow(
      "PR channel is not ready",
    );
    expect(slack.invites.map((invite) => invite.channelId)).toEqual(["C1"]);
  });

  it("does not alert when the aggregate is still failing or pending", async () => {
    await seedPr("sha-1");
    ci = "failing";
    await requestReview();
    await handleCheckRun(deps(), checkRunEvent(payload({ conclusion: "failure" })));
    ci = "pending";
    await handleCheckRun(deps(), checkRunEvent(payload({ id: 101, conclusion: "success" })));
    expect(slack.invites).toHaveLength(0);
  });
});
