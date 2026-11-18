import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import type { JobRow } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import type { CrossReview } from "../pr/crossReview.ts";
import { handlerDeps } from "../testing/deps.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
import { createDispatcher } from "./handlers.ts";

let db: Db;
let slack: FakeSlackGateway;
let close: () => Promise<void>;
let posted: { repo: string; number: number; body: string }[];
let failNextPost: boolean;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackGateway();
  posted = [];
  failNextPost = false;
});
afterEach(() => close());

const crossReview = (repos = ["unkeyed/api"]): CrossReview => ({
  repos: new Set(repos),
  postPrComment: async (repo, number, body) => {
    if (failNextPost) {
      failNextPost = false;
      throw new Error("GitHub API returned HTTP 502");
    }
    posted.push({ repo, number, body });
  },
});

const live = new AbortController().signal;
let deliveries = 0;

const job = (raw: Record<string, unknown>): JobRow => {
  deliveries += 1;
  const createdAt = new Date(Date.UTC(2026, 7, 11, 12, 0, deliveries));
  return {
    id: `delivery-${deliveries}`,
    deliveryId: `delivery-${deliveries}`,
    event: "pull_request",
    action: typeof raw.action === "string" ? raw.action : null,
    raw,
    status: "processing",
    attempts: 1,
    availableAt: createdAt,
    claimedAt: createdAt,
    createdAt,
    lanes: [],
  };
};

const CLAUDE_BODY = "## Summary\nAdds auth.\n\n## Agent or tool used\nClaude Code\n";

const pullRequest = (
  action: string,
  over: { draft?: boolean; body?: string | null; repo?: string; userType?: string } = {},
) => ({
  action,
  repository: { full_name: over.repo ?? "Unkeyed/API" },
  pull_request: {
    number: 1423,
    id: 999,
    draft: over.draft ?? false,
    title: "Add auth",
    body: over.body === undefined ? CLAUDE_BODY : over.body,
    html_url: "https://github.com/unkeyed/api/pull/1423",
    user: { login: "oz", id: 100, type: over.userType ?? "User" },
    head: { sha: "sha1" },
    updated_at: "2026-08-11T12:00:00Z",
  },
});

const dispatcher = (repos?: string[]) =>
  createDispatcher(handlerDeps(db, slack, { crossReview: crossReview(repos) }));

describe("cross-model review request", () => {
  it("asks Pullfrog once for a review by a different model when a PR opens", async () => {
    const dispatch = dispatcher();
    await dispatch(job(pullRequest("opened")), live);
    await dispatch(job(pullRequest("opened")), live);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ repo: "Unkeyed/API", number: 1423 });
    expect(posted[0]?.body.split("\n")[0]).toBe("@pullfrog review --codex");
    expect(slack.channels).toHaveLength(1);
  });

  it("waits for a draft to be marked ready for review", async () => {
    const dispatch = dispatcher();
    await dispatch(job(pullRequest("opened", { draft: true })), live);
    expect(posted).toEqual([]);

    await dispatch(job(pullRequest("ready_for_review")), live);
    await dispatch(job(pullRequest("ready_for_review")), live);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body.split("\n")[0]).toBe("@pullfrog review --codex");
  });

  it("uses the default reviewer for a PR with no body", async () => {
    await dispatcher()(job(pullRequest("opened", { body: null })), live);
    expect(posted.map((p) => p.body.split("\n")[0])).toEqual(["@pullfrog review --codex"]);
  });

  it.each([
    ["the repo is not enabled", pullRequest("opened", { repo: "unkeyed/web" })],
    ["a bot opened the PR", pullRequest("opened", { userType: "Bot" })],
    [
      "the body already asks Pullfrog",
      pullRequest("opened", { body: `${CLAUDE_BODY}\n@pullfrog review this` }),
    ],
    ["the PR is only synchronized", pullRequest("synchronize")],
  ])("stays quiet when %s", async (_, payload) => {
    await dispatcher()(job(payload), live);
    expect(posted).toEqual([]);
    expect(slack.channels).toHaveLength(1);
  });

  it("stays quiet when the feature is off", async () => {
    await createDispatcher(handlerDeps(db, slack))(job(pullRequest("opened")), live);
    expect(posted).toEqual([]);
  });

  it("fails the job when the comment does not post, and posts on the retry", async () => {
    const dispatch = dispatcher();
    failNextPost = true;
    await expect(dispatch(job(pullRequest("opened")), live)).rejects.toThrow("HTTP 502");
    expect(posted).toEqual([]);

    await dispatch(job(pullRequest("opened")), live);
    expect(posted).toHaveLength(1);
  });
});
