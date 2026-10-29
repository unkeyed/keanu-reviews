import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { prId, upsertPullRequest } from "../db/repositories/pullRequests.ts";
import { createTestDb } from "../db/testDb.ts";
import { createLogger } from "../logger.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import { notifyShipped } from "./shipped.ts";

let db: Db;
let slack: FakeSlackClient;
let close: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackClient();
  await upsertPullRequest(db, {
    repoFullName: "unkey/api",
    number: 1423,
    githubPrId: 999,
    currentState: "merged",
  });
});
afterEach(() => close());

const input = () => ({
  prId: prId("unkey/api", 1423),
  repoFullName: "unkey/api",
  number: 1423,
  title: "Add auth",
  htmlUrl: "https://github.com/unkey/api/pull/1423",
  authorMention: "<@U100>",
});

const deps = (shippedChannel?: string) => ({
  db,
  slack,
  logger: createLogger("error"),
  shippedChannel,
});

describe("notifyShipped (R12)", () => {
  it("posts a shipped announcement to a channel given by id", async () => {
    await notifyShipped(deps("C0SHIPPED"), input());
    const msg = slack.messages.at(-1);
    expect(msg?.channel).toBe("C0SHIPPED");
    const text = JSON.stringify(msg?.blocks);
    expect(text).toContain("unkey/api#1423");
    expect(text).toContain("has shipped");
    expect(text).toContain("<@U100>");
  });

  it("resolves a channel name to its id", async () => {
    await slack.createChannel("shipped"); // -> C1
    await notifyShipped(deps("#shipped"), input());
    expect(slack.messages.at(-1)?.channel).toBe("C1");
  });

  it("looks a channel name up once and reuses the id for later merges", async () => {
    await slack.createChannel("shipped");
    await upsertPullRequest(db, {
      repoFullName: "unkey/api",
      number: 1424,
      githubPrId: 1000,
      currentState: "merged",
    });
    const findChannelByName = vi.spyOn(slack, "findChannelByName");

    await notifyShipped(deps("#shipped"), input());
    await notifyShipped(deps("#shipped"), {
      ...input(),
      prId: prId("unkey/api", 1424),
      number: 1424,
    });

    expect(slack.messages.map((message) => message.channel)).toEqual(["C1", "C1"]);
    expect(findChannelByName).toHaveBeenCalledTimes(1);
  });

  it("does not look the channel up again once the announcement was sent", async () => {
    await slack.createChannel("shipped");
    await notifyShipped(deps("#shipped"), input());

    const restarted = new FakeSlackClient();
    await restarted.createChannel("shipped");
    const findChannelByName = vi.spyOn(restarted, "findChannelByName");
    await notifyShipped({ ...deps("#shipped"), slack: restarted }, input());

    expect(findChannelByName).not.toHaveBeenCalled();
    expect(restarted.messages).toHaveLength(0);
  });

  it("does nothing when no shipped channel is configured", async () => {
    await notifyShipped(deps(undefined), input());
    expect(slack.messages).toHaveLength(0);
  });

  it("skips (warns) when the named channel does not exist", async () => {
    await notifyShipped(deps("nonexistent"), input());
    expect(slack.messages).toHaveLength(0);
  });

  it("is idempotent — a redelivered merge does not double-post", async () => {
    await notifyShipped(deps("C0SHIPPED"), input());
    await notifyShipped(deps("C0SHIPPED"), input());
    expect(slack.messages).toHaveLength(1);
  });
});
