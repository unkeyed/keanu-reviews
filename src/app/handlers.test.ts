import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertIdentity } from "#identity";
import { Permanent, Retry, createLogger } from "#lib";
import type { Db } from "../db/client.ts";
import { findByRepoNumber } from "../db/repositories/pullRequests.ts";
import type { JobRow } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
import { createDispatcher } from "./handlers.ts";

let db: Db;
let slack: FakeSlackGateway;
let close: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackGateway();
});
afterEach(() => close());

const createdAt = new Date("2026-08-11T12:00:01.000Z");
const job = (event: string, raw: Record<string, unknown>, attempts = 1): JobRow => ({
  id: "delivery-1",
  deliveryId: "delivery-1",
  event,
  action: typeof raw.action === "string" ? raw.action : null,
  raw,
  status: "processing",
  attempts,
  availableAt: createdAt,
  claimedAt: createdAt,
  createdAt,
});

const pullRequest = (action: string) => ({
  action,
  repository: { full_name: "unkey/api" },
  requested_reviewer: { id: 7, login: "flo" },
  pull_request: {
    number: 1423,
    id: 999,
    title: "Add auth",
    html_url: "https://github.com/unkey/api/pull/1423",
    user: { login: "oz", id: 100 },
    head: { sha: "sha1" },
    updated_at: "2026-08-11T12:00:00Z",
  },
});

describe("createDispatcher", () => {
  it("stamps the job's arrival key on the PR snapshot", async () => {
    const dispatch = createDispatcher({ db, slack, logger: createLogger("error") });
    await dispatch(job("pull_request", pullRequest("opened")));
    const row = await findByRepoNumber(db, "unkey/api", 1423);
    expect(row?.sourceArrivalKey).toBe("2026-08-11T12:00:01.000Z:delivery-1");
  });

  it("runs the lifecycle before the review step and hands it the 1-based attempt", async () => {
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    const dispatch = createDispatcher({
      db,
      slack,
      logger: createLogger("error"),
      fetchCiReadiness: async () => "absent",
    });

    // No check runs yet: attempts below the absent-CI budget retry.
    await expect(dispatch(job("pull_request", pullRequest("review_requested"), 1))).rejects.toThrow(
      Retry,
    );
    expect(slack.channels).toHaveLength(1);
    expect(slack.invites).toEqual([]);

    await dispatch(job("pull_request", pullRequest("review_requested"), 4));
    expect(slack.invites).toEqual([{ channelId: "C1", userIds: ["U7"] }]);
  });

  it("logs an event no handler acts on and does nothing else", async () => {
    const debug = vi.fn();
    const dispatch = createDispatcher({ db, slack, logger: { ...createLogger("error"), debug } });
    await dispatch(job("ping", { zen: "Design for failure." }));
    expect(debug).toHaveBeenCalledWith("unhandled event", {
      event: "ping",
      action: null,
      reason: "unknown event",
    });
    expect(slack.channels).toEqual([]);
  });

  it("rejects a malformed payload permanently", async () => {
    const dispatch = createDispatcher({ db, slack, logger: createLogger("error") });
    await expect(dispatch(job("pull_request", { action: "opened" }))).rejects.toThrow(Permanent);
    expect(slack.channels).toEqual([]);
  });
});
