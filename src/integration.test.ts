import { createHmac } from "node:crypto";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDispatcher, createHttpApp } from "#app";
import type { Db } from "./db/client.ts";
import { createTestDb } from "./db/testDb.ts";
import { createWorker } from "./queue/worker.ts";
import { TEST_ENV, testContext } from "./testing/context.ts";
import { FakeSlackGateway } from "./testing/fakeSlack.ts";
import { drainQueue } from "./testing/queue.ts";

const SECRET = TEST_ENV.GITHUB_WEBHOOK_SECRET;
const REPO = "unkey/api";
let db: Db;
let slack: FakeSlackGateway;
let close: () => Promise<void>;
let route: Hono;
let worker: ReturnType<typeof createWorker>;
let nudges = 0;
let delivery = 0;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackGateway();
  const ctx = testContext(db, slack);
  worker = createWorker(db, ctx.logger, createDispatcher(ctx.deps));
  nudges = 0;
  route = createHttpApp(ctx, () => {
    nudges += 1;
  });
});
afterEach(() => close());

async function deliver(event: string, payload: object): Promise<void> {
  const body = JSON.stringify({
    installation: { id: 42 },
    repository: { full_name: REPO },
    ...payload,
  });
  const sig = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  const res = await route.request("/webhooks/github", {
    method: "POST",
    body,
    headers: {
      "x-hub-signature-256": sig,
      "x-github-event": event,
      "x-github-delivery": `d-${++delivery}`,
    },
  });
  expect([202, 200]).toContain(res.status);
  await drainQueue(worker);
}

const pr = (over: object = {}) => ({
  number: 1423,
  id: 999,
  draft: false,
  merged: false,
  title: "Add auth",
  html_url: `https://github.com/${REPO}/pull/1423`,
  user: { login: "oz", id: 100 },
  head: { sha: "sha1" },
  updated_at: "2026-08-11T12:00:00Z",
  ...over,
});

describe("end-to-end webhook -> Slack smoke", () => {
  it("drives a full PR lifecycle through the real ingestion path", async () => {
    await deliver("pull_request", { action: "opened", pull_request: pr() });
    expect(slack.channels).toHaveLength(1);
    expect(slack.channel("C1")?.name).toBe("pr-oz-unkey-api-1423-add-auth");

    await deliver("pull_request_review_comment", {
      action: "created",
      pull_request: pr(),
      comment: {
        id: 55,
        commit_id: "sha1",
        path: "src/handlers/auth.ts",
        line: 42,
        body: "simplify",
        html_url: `https://github.com/${REPO}/pull/1423#r55`,
        user: { id: 7, login: "flo" },
      },
    });
    const comment = slack.messages.at(-1);
    expect(comment?.threadTs).toBeUndefined();
    expect(JSON.stringify(comment?.blocks)).toContain(
      "https://github.com/unkey/api/pull/1423#r55|Open",
    );

    const beforeCi = slack.messages.length;
    await deliver("check_run", {
      action: "completed",
      check_run: {
        id: 100,
        status: "completed",
        conclusion: "success",
        html_url: `https://github.com/${REPO}/runs/100`,
        head_sha: "sha1",
        name: "test",
      },
    });
    expect(slack.messages).toHaveLength(beforeCi);
    expect(JSON.stringify(slack.messages)).not.toContain("Ready to merge");
    expect(JSON.stringify(slack.messages)).not.toContain("checks are failing");

    await deliver("pull_request", { action: "closed", pull_request: pr({ merged: true }) });
    expect(slack.channel("C1")?.name).toBe("merged-oz-unkey-api-1423-add-auth");
    expect(slack.channel("C1")?.archived).toBe(true);

    expect(slack.channels).toHaveLength(1);
    expect(nudges).toBe(delivery);
  });
});
