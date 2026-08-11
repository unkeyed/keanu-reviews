import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { setChannel, upsertPullRequest } from "../db/repositories/pullRequests.ts";
import { pullRequests, reminders } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { createLogger } from "../logger.ts";
import { createReminderScheduler } from "../scheduler/reminders.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import {
  type IssueCommentPayload,
  type ReviewPayload,
  handleIssueComment,
  handleReview,
} from "./review.ts";

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

const deps = (over = {}) => ({ db, slack, logger: createLogger("error"), ...over });

const review = (state: string): ReviewPayload => ({
  action: "submitted",
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
    updated_at: "2026-08-11T12:00:00Z",
  },
  review: {
    id: 1,
    state,
    body: "looks good",
    html_url: "https://github.com/unkey/api/pull/1#pullrequestreview-1",
    user: { id: 7, login: "flo" },
  },
});

describe("handleReview (U6, R5)", () => {
  it("posts a distinct summary for changes_requested vs approved", async () => {
    await handleReview(deps(), review("approved"));
    const approved = JSON.stringify(slack.messages.at(-1)?.blocks);
    slack.messages.length = 0;
    await handleReview(deps(), {
      ...review("changes_requested"),
      review: { ...review("changes_requested").review, id: 2 },
    });
    const changes = JSON.stringify(slack.messages.at(-1)?.blocks);
    expect(approved).toContain("approved");
    expect(changes).toContain("requested changes");
    expect(approved).not.toBe(changes);
  });

  it("fires the reminder-cancel hook for the reviewer", async () => {
    const onReviewSubmitted = vi.fn(async () => {});
    await handleReview(deps({ onReviewSubmitted }), review("approved"));
    expect(onReviewSubmitted).toHaveBeenCalledWith(
      "unkey/api#1",
      7,
      new Date("2026-08-11T12:00:00Z"),
      "1",
    );
  });

  it("cancels the reminder before a fallible Slack delivery", async () => {
    const scheduler = createReminderScheduler({
      db,
      slack,
      logger: createLogger("error"),
      reminderHours: 12,
      now: () => Date.parse("2026-08-11T11:00:00Z"),
    });
    await scheduler.onReviewRequested("unkey/api#1", 7, new Date("2026-08-11T11:00:00Z"));
    slack.postMessage = async () => {
      throw new Error("Slack unavailable");
    };

    await expect(
      handleReview(deps({ onReviewSubmitted: scheduler.onReviewSubmitted }), review("approved")),
    ).rejects.toThrow("Slack unavailable");
    const [reminder] = await db.select().from(reminders).where(eq(reminders.prId, "unkey/api#1"));
    expect(reminder?.status).toBe("cancelled");
  });

  it("reconciles the parent channel when a review arrives before opened", async () => {
    await db.delete(pullRequests);
    await handleReview(deps(), review("approved"));
    expect(slack.channels).toHaveLength(1);
    expect(slack.messages.at(-1)?.threadTs).toBeDefined();
  });
});

describe("handleIssueComment (U6)", () => {
  const issueComment = (isPr: boolean): IssueCommentPayload => ({
    action: "created",
    repository: { full_name: "unkey/api" },
    issue: { number: 1, pull_request: isPr ? {} : undefined },
    comment: {
      id: 3,
      body: "thoughts?",
      html_url: "https://github.com/unkey/api/pull/1#issuecomment-3",
      user: { id: 7, login: "flo" },
    },
  });

  it("mirrors a PR conversation comment", async () => {
    await handleIssueComment(deps(), issueComment(true));
    expect(slack.messages.at(-1)?.text).toContain("flo");
  });

  it("ignores a comment on a non-PR issue", async () => {
    await handleIssueComment(deps(), issueComment(false));
    expect(slack.messages).toHaveLength(0);
  });

  it("throws for a PR comment whose parent mapping is not ready", async () => {
    await db.delete(pullRequests);
    await expect(handleIssueComment(deps(), issueComment(true))).rejects.toThrow(
      "PR channel is not ready",
    );
  });

  it("keeps the final rendered issue-comment section within Slack's limit", async () => {
    const input = issueComment(true);
    input.comment.body = `${"x\n".repeat(2_000)}<!channel>`;
    input.comment.user.login = "<!everyone>";
    await handleIssueComment(deps(), input);
    const block = slack.messages.at(-1)?.blocks?.[0] as { text?: { text?: string } };
    expect(block.text?.text?.length).toBeLessThanOrEqual(3_000);
    expect(JSON.stringify(slack.messages.at(-1))).not.toContain("<!channel>");
    expect(JSON.stringify(slack.messages.at(-1))).not.toContain("<!everyone>");
  });
});
