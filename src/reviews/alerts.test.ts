import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "#app";
import { jobArrivalKey } from "#events";
import { upsertIdentity } from "#identity";
import { createLogger } from "#lib";
import type { Db } from "../db/client.ts";
import { pullRequests, reminders } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import type { CiReadiness } from "../github/ci.ts";
import { applyPullRequestSource, setChannel } from "../pr/store.ts";
import { handlerDeps } from "../testing/deps.ts";
import { type PullRequestPayload, pullRequestEvent } from "../testing/events.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
import { convergePullRequest, inSession } from "../testing/pr.ts";
import { onPullRequest } from "./alerts.ts";

const handle = inSession(onPullRequest);

let db: Db;
let slack: FakeSlackGateway;
let close: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackGateway();
  const row = (
    await applyPullRequestSource(db, {
      repoFullName: "unkey/api",
      number: 1,
      githubPrId: 1,
      currentState: "pr",
    })
  ).row;
  await setChannel(db, row.id, "C1", "ts-root");
});
afterEach(() => close());

const payload = (over: Partial<PullRequestPayload> = {}): PullRequestPayload => ({
  action: "review_requested",
  repository: { full_name: "unkey/api" },
  pull_request: {
    number: 1,
    id: 1,
    draft: false,
    merged: false,
    title: "Review me",
    html_url: "https://github.com/unkey/api/pull/1",
    user: { login: "oz", id: 100 },
    head: { sha: "sha-1" },
    updated_at: "2026-08-11T12:00:00Z",
  },
  requested_reviewer: { id: 7, login: "flo" },
  ...over,
});

const readyPayload = (over: Partial<PullRequestPayload["pull_request"]> = {}) => ({
  action: "ready_for_review",
  repository: { full_name: "unkey/api" },
  pull_request: {
    ...payload().pull_request,
    draft: false,
    requested_reviewers: [{ id: 7, login: "flo" }],
    ...over,
  },
});

const deps = (over: Partial<HandlerDeps> = {}) => handlerDeps(db, slack, over);
/** The job a step runs in; ids sort in call order, as arrival keys do. */
const work = (id: string, attempt = 1) => ({
  arrivalKey: jobArrivalKey(new Date(0), id),
  attempt,
  signal: new AbortController().signal,
});
let jobs = 0;
const nextJob = (attempt = 1) => work(`job-${String(++jobs).padStart(4, "0")}`, attempt);

const linkFlo = () =>
  upsertIdentity(db, {
    githubUserId: 7,
    githubLogin: "flo",
    slackUserId: "U7",
    source: "self-link",
  });

const reminderRows = () => db.select().from(reminders).where(eq(reminders.prId, "unkey/api#1"));

const seedHeadSha = () =>
  applyPullRequestSource(db, {
    repoFullName: "unkey/api",
    number: 1,
    githubPrId: 1,
    currentState: "pr",
    headSha: "sha-1",
  });

describe("review requests (U5)", () => {
  it("invites a mapped reviewer by stored Slack id", async () => {
    await linkFlo();
    await handle(deps(), pullRequestEvent(payload()), nextJob());
    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["U7"] }]);
  });

  it("resolves an unmapped reviewer by public email, caches, and invites", async () => {
    slack.emailToUser.set("flo@unkey.com", "U9");
    const fetchGithubEmail = vi.fn(async () => "flo@unkey.com");
    await handle(deps({ fetchGithubEmail }), pullRequestEvent(payload()), nextJob());
    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["U9"] }]);
    // cached: a second request needs no email lookup
    await handle(
      deps({ fetchGithubEmail }),
      pullRequestEvent(payload({ requested_reviewer: { id: 7, login: "flo" } })),
      nextJob(),
    );
    expect(fetchGithubEmail).toHaveBeenCalledTimes(1);
  });

  it("posts the review note and warns when Slack refuses to invite the reviewer", async () => {
    await linkFlo();
    slack.uninvitableUsers.set("U7", "user_is_ultra_restricted");
    const warn = vi.fn();

    await handle(
      deps({ logger: { ...createLogger("error"), warn } }),
      pullRequestEvent(payload()),
      nextJob(),
    );

    expect(slack.invites).toHaveLength(0);
    expect(slack.messages.at(-1)?.text).toContain("Review requested from flo");
    expect(warn).toHaveBeenCalledWith(
      "Slack refused to invite user into channel",
      expect.objectContaining({ userId: "U7", slackError: "user_is_ultra_restricted" }),
    );
  });

  it("degrades to a plain-login note when identity cannot be resolved", async () => {
    const fetchGithubEmail = vi.fn(async () => undefined);
    await handle(deps({ fetchGithubEmail }), pullRequestEvent(payload()), nextJob());
    expect(slack.invites).toHaveLength(0);
    expect(slack.messages.at(-1)?.text).toContain("flo");
  });

  it("skips user lookup for a team request", async () => {
    const fetchGithubEmail = vi.fn();
    await handle(
      deps({ fetchGithubEmail }),
      pullRequestEvent(
        payload({ requested_reviewer: undefined, requested_team: { id: 1, slug: "core" } }),
      ),
      nextJob(),
    );
    expect(slack.invites).toHaveLength(0);
    expect(fetchGithubEmail).not.toHaveBeenCalled();
  });

  it("does not double-invite on a duplicate review_requested", async () => {
    await linkFlo();
    await handle(deps(), pullRequestEvent(payload()), nextJob());
    await handle(deps(), pullRequestEvent(payload()), nextJob());
    expect(slack.invites).toHaveLength(1);
  });

  it("reconciles the parent channel when a review request arrives first", async () => {
    await db.delete(pullRequests);
    await handle(
      deps({ fetchGithubEmail: async () => undefined }),
      pullRequestEvent(payload()),
      nextJob(),
    );
    expect(slack.channels).toHaveLength(1);
    expect(slack.messages.at(-1)?.channel).toBeDefined();
  });

  it("retries the request after a failed Slack post without duplicating the invite", async () => {
    await linkFlo();
    const post = slack.post.bind(slack);
    let fail = true;
    slack.post = async (channel, message, opts) => {
      if (fail) {
        fail = false;
        throw new Error("transient Slack failure");
      }
      return post(channel, message, opts);
    };

    await expect(handle(deps(), pullRequestEvent(payload()), nextJob())).rejects.toThrow(
      "transient Slack failure",
    );
    await handle(deps(), pullRequestEvent(payload()), nextJob());
    expect(slack.invites).toHaveLength(1);
    expect(slack.messages).toHaveLength(1);
  });

  it("sanitizes an unresolved reviewer's login", async () => {
    await handle(
      deps({ fetchGithubEmail: async () => undefined }),
      pullRequestEvent(payload({ requested_reviewer: { id: 8, login: "<!channel>" } })),
      nextJob(),
    );
    expect(JSON.stringify(slack.messages.at(-1))).not.toContain("<!channel>");
  });

  it("schedules the reminder on request and cancels it on removal, stamped by the event", async () => {
    const request = work("delivery-1-request");
    await handle(deps(), pullRequestEvent(payload()), request);
    const [scheduled] = await reminderRows();
    expect(scheduled).toMatchObject({
      reviewerGithubId: 7,
      status: "pending",
      sourceUpdatedAt: new Date("2026-08-11T12:00:00Z"),
      sourceVersion: request.arrivalKey,
    });

    const removal = work("delivery-2-remove");
    await handle(deps(), pullRequestEvent(payload({ action: "review_request_removed" })), removal);
    const [cancelled] = await reminderRows();
    expect(cancelled).toMatchObject({
      status: "cancelled",
      sourceUpdatedAt: new Date("2026-08-11T12:00:00Z"),
      sourceVersion: removal.arrivalKey,
    });
  });

  it("defers the invite and reminder when review is requested on a draft PR", async () => {
    await linkFlo();
    await handle(
      deps(),
      pullRequestEvent(payload({ pull_request: { ...payload().pull_request, draft: true } })),
      nextJob(),
    );
    expect(slack.invites).toHaveLength(0); // not pulled in yet
    expect(slack.messages).toHaveLength(0); // no "Review requested" note
    expect(await reminderRows()).toEqual([]); // no reminder scheduled
  });

  it("invites reviewers assigned while draft once the PR is marked ready", async () => {
    await linkFlo();
    const ready = work("delivery-ready-1");
    await handle(deps(), pullRequestEvent(readyPayload()), ready);
    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["U7"] }]);
    const [row] = await reminderRows();
    expect(row).toMatchObject({
      reviewerGithubId: 7,
      sourceUpdatedAt: new Date("2026-08-11T12:00:00Z"),
      sourceVersion: ready.arrivalKey,
    });
  });

  it("does nothing on ready_for_review when no reviewers are requested", async () => {
    await handle(
      deps(),
      pullRequestEvent({
        action: "ready_for_review",
        repository: { full_name: "unkey/api" },
        pull_request: { ...payload().pull_request, requested_reviewers: [] },
      }),
      nextJob(),
    );
    expect(slack.invites).toHaveLength(0);
    expect(slack.messages).toHaveLength(0);
  });

  it("does not alert while CI is failing or still running", async () => {
    await seedHeadSha();
    await linkFlo();
    await handle(
      deps({ fetchCiReadiness: async () => "failing" }),
      pullRequestEvent(payload()),
      nextJob(),
    );
    expect(slack.invites).toHaveLength(0);
    expect(slack.messages).toHaveLength(0);
    const [row] = await reminderRows();
    expect(row?.status).toBe("pending");
    const generation = row?.generation;

    await handle(
      deps({ fetchCiReadiness: async () => "pending" }),
      pullRequestEvent(
        payload({
          pull_request: { ...payload().pull_request, updated_at: "2026-08-11T12:05:00Z" },
        }),
      ),
      work("delivery-pending"),
    );
    expect(slack.invites).toHaveLength(0);
    expect(slack.messages).toHaveLength(0);
    const [still] = await reminderRows();
    expect(still?.generation).toBe(generation);
  });

  it("alerts immediately when CI is already passing", async () => {
    await seedHeadSha();
    await linkFlo();
    await handle(
      deps({ fetchCiReadiness: async () => "passing" }),
      pullRequestEvent(payload()),
      nextJob(),
    );
    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["U7"] }]);
    const rows = await reminderRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.generation).toBe(1);
    expect(JSON.stringify(slack.messages)).not.toContain("Ready to merge");
    expect(JSON.stringify(slack.messages)).not.toContain("checks are failing");
  });

  it("retries while CI has not registered, then alerts if it never does", async () => {
    await seedHeadSha();
    await linkFlo();
    const waiting = deps({ fetchCiReadiness: async () => "absent" });
    await expect(
      handle(waiting, pullRequestEvent(payload()), work("delivery-absent", 1)),
    ).rejects.toThrow("CI has not reported");
    expect(slack.invites).toHaveLength(0);

    await handle(waiting, pullRequestEvent(payload()), work("delivery-absent", 4));
    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["U7"] }]);
  });

  it("does not alert on ready_for_review while CI is failing", async () => {
    await applyPullRequestSource(db, {
      repoFullName: "unkey/api",
      number: 1,
      githubPrId: 1,
      currentState: "draft",
      headSha: "sha-1",
    });
    await linkFlo();
    await handle(
      deps({ fetchCiReadiness: async () => "failing" }),
      pullRequestEvent(payload({ pull_request: { ...payload().pull_request, draft: true } })),
      nextJob(),
    );
    await handle(
      deps({ fetchCiReadiness: async () => "failing" }),
      pullRequestEvent(readyPayload({ updated_at: "2026-08-11T13:00:00Z" })),
      work("delivery-ready"),
    );
    expect(slack.invites).toHaveLength(0);
    expect(slack.messages).toHaveLength(0);
  });

  it("does not alert on a stale ready_for_review that lands after converted_to_draft", async () => {
    await db.delete(pullRequests);
    await linkFlo();
    await convergePullRequest(
      deps(),
      pullRequestEvent({
        action: "converted_to_draft",
        repository: { full_name: "unkey/api" },
        pull_request: {
          ...payload().pull_request,
          draft: true,
          updated_at: "2026-08-11T12:05:00Z",
        },
      }),
    );

    const lifecycle = await convergePullRequest(deps(), pullRequestEvent(readyPayload()));
    await handle(deps(), pullRequestEvent(readyPayload()), work("delivery-stale-ready"));

    expect(lifecycle?.accepted).toBe(false);
    expect(slack.invites).toHaveLength(0);
    expect(JSON.stringify(slack.messages)).not.toContain("Review requested");
    expect(await reminderRows()).toEqual([]);
  });

  it("does not alert or reopen the channel when the PR merges during the CI wait", async () => {
    await db.delete(pullRequests);
    await linkFlo();
    const waiting = deps({ fetchCiReadiness: async () => "absent" });
    await convergePullRequest(deps(), pullRequestEvent(readyPayload()));
    await expect(
      handle(waiting, pullRequestEvent(readyPayload()), work("delivery-ready", 1)),
    ).rejects.toThrow("CI has not reported");

    await convergePullRequest(
      deps(),
      pullRequestEvent({
        action: "closed",
        repository: { full_name: "unkey/api" },
        pull_request: {
          ...payload().pull_request,
          merged: true,
          updated_at: "2026-08-11T12:10:00Z",
        },
      }),
    );
    await handle(waiting, pullRequestEvent(readyPayload()), work("delivery-ready", 4));
    await handle(waiting, pullRequestEvent(payload()), work("delivery-request", 4));

    expect(slack.invites).toHaveLength(0);
    expect(JSON.stringify(slack.messages)).not.toContain("Review requested");
    expect(slack.channels).toEqual([expect.objectContaining({ archived: true })]);
  });

  it("converges the invite again for a later review request", async () => {
    await linkFlo();
    await handle(deps(), pullRequestEvent(payload()), work("delivery-request-1"));
    await handle(
      deps(),
      pullRequestEvent(
        payload({
          action: "review_request_removed",
          pull_request: { ...payload().pull_request, updated_at: "2026-08-11T12:01:00Z" },
        }),
      ),
      work("delivery-remove-1"),
    );

    // Model the reviewer no longer being in the channel after the first request.
    slack.invites.length = 0;
    await handle(
      deps(),
      pullRequestEvent(
        payload({
          pull_request: { ...payload().pull_request, updated_at: "2026-08-11T12:02:00Z" },
        }),
      ),
      work("delivery-request-2"),
    );

    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["U7"] }]);
    expect(slack.messages).toHaveLength(2);
  });

  it("restarts the reminder clock when the held alert finally posts", async () => {
    await seedHeadSha();
    await linkFlo();
    let ci: CiReadiness = "failing";
    const alertedAt = new Date("2026-08-11T15:00:00Z");
    const d = deps({ fetchCiReadiness: async () => ci, clock: { now: () => alertedAt } });
    await handle(d, pullRequestEvent(payload()), nextJob());
    const [held] = await reminderRows();
    expect(held?.dueAt).toEqual(new Date("2026-08-12T00:00:00Z")); // request + 12h

    ci = "passing";
    await handle(
      d,
      pullRequestEvent({
        action: "synchronize",
        repository: { full_name: "unkey/api" },
        pull_request: { ...payload().pull_request, requested_reviewers: [{ id: 7, login: "flo" }] },
      }),
      nextJob(),
    );

    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["U7"] }]);
    const [alerted] = await reminderRows();
    expect(alerted?.dueAt).toEqual(new Date("2026-08-12T03:00:00Z")); // alert + 12h
    expect(alerted?.generation).toBe(held?.generation);
  });

  it("reads no CI for a push whose reviewers were already alerted", async () => {
    await seedHeadSha();
    await linkFlo();
    await handle(deps(), pullRequestEvent(payload()), nextJob());
    expect(slack.messages).toHaveLength(1);

    const fetchCiReadiness = vi.fn(async (): Promise<CiReadiness> => "absent");
    const push = pullRequestEvent({
      action: "synchronize",
      repository: { full_name: "unkey/api" },
      pull_request: { ...payload().pull_request, requested_reviewers: [{ id: 7, login: "flo" }] },
    });
    // Attempt 1 with no check runs would retry if CI were read.
    await handle(deps({ fetchCiReadiness }), push, nextJob(1));

    expect(fetchCiReadiness).not.toHaveBeenCalled();
    expect(slack.messages).toHaveLength(1);
  });
});
