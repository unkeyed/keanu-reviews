import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import { findByRepoNumber, prId } from "../db/repositories/pullRequests.ts";
import { createTestDb } from "../db/testDb.ts";
import { createLogger } from "../logger.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import { type PullRequestPayload, handlePullRequest } from "./pullRequest.ts";

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

const payload = (action: string, over: Partial<PullRequestPayload["pull_request"]> = {}) =>
  ({
    action,
    repository: { full_name: "unkey/api" },
    pull_request: {
      number: 1423,
      id: 999,
      draft: false,
      merged: false,
      title: "Add auth",
      html_url: "https://github.com/unkey/api/pull/1423",
      user: { login: "oz" },
      head: { sha: "sha1" },
      ...over,
    },
  }) satisfies PullRequestPayload;

const deps = () => ({ db, slack, logger: createLogger("error") });

describe("handlePullRequest (U4 channel lifecycle)", () => {
  it("opened draft creates a draft-* channel, stores mapping + root ts", async () => {
    await handlePullRequest(deps(), payload("opened", { draft: true }));
    expect(slack.channels).toHaveLength(1);
    expect(slack.channels[0]?.name).toBe("draft-api-1423");
    const row = await findByRepoNumber(db, "unkey/api", 1423);
    expect(row?.channelId).toBe("C1");
    expect(row?.rootMessageTs).toBe("ts-1");
    expect(row?.currentState).toBe("draft");
  });

  it("ready_for_review renames draft -> pr; converted_to_draft renames back", async () => {
    await handlePullRequest(deps(), payload("opened", { draft: true }));
    await handlePullRequest(deps(), payload("ready_for_review", { draft: false }));
    expect(slack.channel("C1")?.name).toBe("pr-api-1423");
    await handlePullRequest(deps(), payload("converted_to_draft", { draft: true }));
    expect(slack.channel("C1")?.name).toBe("draft-api-1423");
  });

  it("closed+merged renames to merged then archives (rename precedes archive)", async () => {
    await handlePullRequest(deps(), payload("opened"));
    await handlePullRequest(deps(), payload("closed", { merged: true }));
    const ch = slack.channel("C1");
    expect(ch?.name).toBe("merged-api-1423");
    expect(ch?.archived).toBe(true);
  });

  it("closed without merge renames to closed then archives", async () => {
    await handlePullRequest(deps(), payload("opened"));
    await handlePullRequest(deps(), payload("closed", { merged: false }));
    expect(slack.channel("C1")?.name).toBe("closed-api-1423");
    expect(slack.channel("C1")?.archived).toBe(true);
  });

  it("reopened unarchives and renames to pr", async () => {
    await handlePullRequest(deps(), payload("opened"));
    await handlePullRequest(deps(), payload("closed", { merged: false }));
    await handlePullRequest(deps(), payload("reopened"));
    expect(slack.channel("C1")?.archived).toBe(false);
    expect(slack.channel("C1")?.name).toBe("pr-api-1423");
  });

  it("re-delivered opened event does not create a second channel", async () => {
    await handlePullRequest(deps(), payload("opened"));
    await handlePullRequest(deps(), payload("opened"));
    expect(slack.channels).toHaveLength(1);
    expect(await findByRepoNumber(db, "unkey/api", 1423).then((r) => r?.id)).toBe(
      prId("unkey/api", 1423),
    );
  });
});
