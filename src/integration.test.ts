import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db/client.ts";
import { createTestDb } from "./db/testDb.ts";
import { createLogger } from "./logger.ts";
import { createGithubWebhookRoute } from "./routes/githubWebhook.ts";
import { createReminderScheduler } from "./scheduler/reminders.ts";
import { FakeSlackClient } from "./testing/fakeSlack.ts";
import { createWorker } from "./worker/loop.ts";
import { createRouter } from "./worker/router.ts";

/**
 * Offline end-to-end smoke (Verification Contract). Replays signed webhook
 * fixtures through the real ingestion route -> job queue -> worker -> handlers,
 * with a fake Slack client. The live gate (real Slack workspace + GitHub App)
 * still needs credentials; this proves the wiring end to end.
 */
const SECRET = "whsec_test";
const REPO = "unkey/api";
let db: Db;
let slack: FakeSlackClient;
let close: () => Promise<void>;
let route: ReturnType<typeof createGithubWebhookRoute>;
let worker: ReturnType<typeof createWorker>;
let delivery = 0;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
  slack = new FakeSlackClient();
  const logger = createLogger("error");
  const scheduler = createReminderScheduler({ db, slack, logger, reminderHours: 12 });
  const router = createRouter({
    db,
    slack,
    logger,
    reminderHours: 12,
    onReviewRequested: scheduler.onReviewRequested,
    onReviewSubmitted: scheduler.onReviewSubmitted,
    onReviewRequestRemoved: scheduler.onReviewRequestRemoved,
  });
  worker = createWorker({ db, logger, router });
  route = createGithubWebhookRoute({
    db,
    logger,
    webhookSecret: SECRET,
    allowedInstallationIds: ["42"],
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
  await worker.drain();
}

const pr = (over: object = {}) => ({
  number: 1423,
  id: 999,
  draft: false,
  merged: false,
  title: "Add auth",
  html_url: `https://github.com/${REPO}/pull/1423`,
  user: { login: "oz" },
  head: { sha: "sha1" },
  updated_at: "2026-08-11T12:00:00Z",
  ...over,
});

describe("end-to-end webhook -> Slack smoke", () => {
  it("drives a full PR lifecycle through the real ingestion path", async () => {
    // 1. opened -> channel created
    await deliver("pull_request", { action: "opened", pull_request: pr() });
    expect(slack.channels).toHaveLength(1);
    expect(slack.channel("C1")?.name).toBe("pr-api-1423");

    // 2. inline review comment -> threaded with an Open-at-line permalink
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
    expect(comment?.threadTs).toBe("ts-1");
    expect(JSON.stringify(comment?.blocks)).toContain(
      "https://github.com/unkey/api/blob/sha1/src/handlers/auth.ts#L42|Open",
    );

    // 3. CI result -> channel message mapped by head_sha
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
    expect(JSON.stringify(slack.messages.at(-1)?.blocks)).toContain("passed");

    // 4. merged -> rename to merged then archive
    await deliver("pull_request", { action: "closed", pull_request: pr({ merged: true }) });
    expect(slack.channel("C1")?.name).toBe("merged-api-1423");
    expect(slack.channel("C1")?.archived).toBe(true);

    // Still exactly one channel throughout.
    expect(slack.channels).toHaveLength(1);
  });
});
