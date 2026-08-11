import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { upsertIdentity } from "../db/repositories/identities.ts";
import { setChannel, upsertPullRequest } from "../db/repositories/pullRequests.ts";
import { pullRequests } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { createLogger } from "../logger.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import { type ReviewRequestPayload, handleReviewRequest } from "./reviewRequest.ts";

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

const payload = (over: Partial<ReviewRequestPayload> = {}): ReviewRequestPayload => ({
  action: "review_requested",
  repository: { full_name: "unkey/api" },
  pull_request: {
    number: 1,
    id: 1,
    draft: false,
    merged: false,
    title: "Review me",
    html_url: "https://github.com/unkey/api/pull/1",
    user: { login: "oz" },
    head: { sha: "sha-1" },
  },
  requested_reviewer: { id: 7, login: "flo" },
  ...over,
});

const deps = (over = {}) => ({ db, slack, logger: createLogger("error"), ...over });

describe("handleReviewRequest (U5)", () => {
  it("invites a mapped reviewer by stored Slack id", async () => {
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    await handleReviewRequest(deps(), payload());
    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["U7"] }]);
  });

  it("resolves an unmapped reviewer by public email, caches, and invites", async () => {
    slack.emailToUser.set("flo@unkey.com", "U9");
    const fetchGithubEmail = vi.fn(async () => "flo@unkey.com");
    await handleReviewRequest(deps({ fetchGithubEmail }), payload());
    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["U9"] }]);
    // cached: a second request needs no email lookup
    await handleReviewRequest(
      deps({ fetchGithubEmail }),
      payload({ requested_reviewer: { id: 7, login: "flo" } }),
    );
    expect(fetchGithubEmail).toHaveBeenCalledTimes(1);
  });

  it("degrades to a plain-login note when identity cannot be resolved", async () => {
    const fetchGithubEmail = vi.fn(async () => undefined);
    await handleReviewRequest(deps({ fetchGithubEmail }), payload());
    expect(slack.invites).toHaveLength(0);
    expect(slack.messages.at(-1)?.text).toContain("flo");
  });

  it("skips user lookup for a team request", async () => {
    const fetchGithubEmail = vi.fn();
    await handleReviewRequest(
      deps({ fetchGithubEmail }),
      payload({ requested_reviewer: undefined, requested_team: { id: 1, slug: "core" } }),
    );
    expect(slack.invites).toHaveLength(0);
    expect(fetchGithubEmail).not.toHaveBeenCalled();
  });

  it("does not double-invite on a duplicate review_requested", async () => {
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    await handleReviewRequest(deps(), payload());
    await handleReviewRequest(deps(), payload());
    expect(slack.invites).toHaveLength(1);
  });

  it("reconciles the parent channel when a review request arrives first", async () => {
    await db.delete(pullRequests);
    await handleReviewRequest(deps({ fetchGithubEmail: async () => undefined }), payload());
    expect(slack.channels).toHaveLength(1);
    expect(slack.messages.at(-1)?.threadTs).toBeDefined();
  });

  it("retries the request after a failed Slack post without duplicating the invite", async () => {
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    const post = slack.postMessage.bind(slack);
    let fail = true;
    slack.postMessage = async (message) => {
      if (fail) {
        fail = false;
        throw new Error("transient Slack failure");
      }
      return post(message);
    };

    await expect(handleReviewRequest(deps(), payload())).rejects.toThrow("transient Slack failure");
    await handleReviewRequest(deps(), payload());
    expect(slack.invites).toHaveLength(1);
    expect(slack.messages).toHaveLength(1);
  });

  it("sanitizes an unresolved reviewer's login", async () => {
    await handleReviewRequest(
      deps({ fetchGithubEmail: async () => undefined }),
      payload({ requested_reviewer: { id: 8, login: "<!channel>" } }),
    );
    expect(JSON.stringify(slack.messages.at(-1))).not.toContain("<!channel>");
  });

  it("fires the reminder schedule hook on request and cancel hook on removal", async () => {
    const onReviewRequested = vi.fn(async () => {});
    const onReviewRequestRemoved = vi.fn(async () => {});
    await handleReviewRequest(deps({ onReviewRequested, onReviewRequestRemoved }), payload());
    expect(onReviewRequested).toHaveBeenCalledWith("unkey/api#1", 7);
    await handleReviewRequest(
      deps({ onReviewRequested, onReviewRequestRemoved }),
      payload({ action: "review_request_removed" }),
    );
    expect(onReviewRequestRemoved).toHaveBeenCalledWith("unkey/api#1", 7);
  });
});
