import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HandlerDeps, handlers } from "#app";
import { type ReviewEvent, jobArrivalKey, parseEvent } from "#events";
import { upsertIdentity } from "#identity";
import { scheduleReminder } from "#reminders";
import { onCheckRun, onPullRequest } from "#reviews";
import { SlackApiError } from "#slack";
import type { Db } from "../db/client.ts";
import { pullRequests, reminders } from "../db/schema.ts";
import { createTestDb } from "../db/testDb.ts";
import { PullRequestLifecycleBusyError } from "../pr/session.ts";
import {
  applyPullRequestSource,
  claimPullRequestLifecycle,
  prId,
  setChannel,
} from "../pr/store.ts";
import { handlerDeps } from "../testing/deps.ts";
import {
  type IssueCommentPayload,
  type ReviewPayload,
  checkRunEvent,
  issueCommentEvent,
  pullRequestEvent,
  reviewEvent,
} from "../testing/events.ts";
import { FakeSlackGateway } from "../testing/fakeSlack.ts";
import { inSession } from "../testing/pr.ts";
import { onIssueComment } from "./comments.ts";

const handleReviewRequest = inSession(onPullRequest);
const reviewArrival = jobArrivalKey(new Date(0), "review");
/** A review job as the worker runs it: reminder cancel, then the mirror. */
const handleReview = (deps: HandlerDeps, ev: ReviewEvent, arrivalKey = reviewArrival) =>
  handlers.review(deps, ev, { arrivalKey, attempt: 1, signal: new AbortController().signal });

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

const deps = (over: Partial<HandlerDeps> = {}) => handlerDeps(db, slack, over);
const reminderRow = async () =>
  (await db.select().from(reminders).where(eq(reminders.prId, "unkey/api#1")))[0];

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
    user: { login: "oz", id: 100 },
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

describe("review job (U6, R5)", () => {
  it("posts a distinct summary for changes_requested vs approved", async () => {
    await handleReview(deps(), reviewEvent(review("approved")));
    const approved = JSON.stringify(slack.messages.at(-1)?.blocks);
    slack.messages.length = 0;
    await handleReview(
      deps(),
      reviewEvent({
        ...review("changes_requested"),
        review: { ...review("changes_requested").review, id: 2 },
      }),
    );
    const changes = JSON.stringify(slack.messages.at(-1)?.blocks);
    expect(approved).toContain("approved");
    expect(changes).toContain("requested changes");
    expect(approved).not.toBe(changes);
  });

  it.each(["approved", "changes_requested", "commented"])(
    "shows the reviewer's plain Slack name without pinging them (%s)",
    async (state) => {
      await upsertIdentity(db, {
        githubUserId: 7,
        githubLogin: "flo",
        slackUserId: "U7",
        source: "self-link",
      });
      slack.profiles.set("U7", { name: "James Perkins" });

      await handleReview(deps(), reviewEvent(review(state)));
      const blocks = JSON.stringify(slack.messages.at(-1)?.blocks);
      expect(blocks).toContain("James Perkins");
      expect(blocks).not.toContain("<@U7>"); // never a mention = never a notification
    },
  );

  it("falls back to the GitHub login when the reviewer has no Slack name", async () => {
    // No identity mapping and no display name available.
    await handleReview(deps(), reviewEvent(review("approved")));
    const blocks = JSON.stringify(slack.messages.at(-1)?.blocks);
    expect(blocks).toContain("flo");
    expect(blocks).not.toContain("<@");
  });

  it("labels the review with the login when Slack's profile read fails", async () => {
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    vi.spyOn(slack, "profile").mockRejectedValue(new SlackApiError("users.info", "ratelimited"));
    await handleReview(deps(), reviewEvent(review("approved")));
    const blocks = JSON.stringify(slack.messages.at(-1)?.blocks);
    expect(blocks).toContain("approved");
    expect(blocks).toContain("flo");
  });

  it("authors the review summary AS the reviewer via their token (no name label)", async () => {
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    slack.profiles.set("U7", { name: "James Perkins" });
    const authorPoster = {
      getUserToken: async (id: string) => (id === "U7" ? "xoxp-flo" : undefined),
      onInvalidToken: async () => {},
    };
    await handleReview(deps({ authorPoster }), reviewEvent(review("approved")));
    const msg = slack.messages.at(-1);
    expect(msg?.authorUserToken).toBe("xoxp-flo"); // posted as the reviewer
    const blocks = JSON.stringify(msg?.blocks);
    expect(blocks).toContain("approved");
    expect(blocks).not.toContain("by James Perkins"); // authored as them, so no label
    expect(blocks).not.toContain("<@"); // still never a mention
  });

  it("drops a dead token and posts the review as the bot with the reviewer's name", async () => {
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    slack.profiles.set("U7", { name: "James Perkins", iconUrl: "https://slack/a.png" });
    slack.invalidTokens.add("xoxp-dead");
    const dropped: string[] = [];
    const authorPoster = {
      getUserToken: async () => "xoxp-dead",
      onInvalidToken: async (id: string) => {
        dropped.push(id);
      },
    };
    await handleReview(deps({ authorPoster }), reviewEvent(review("approved")));

    expect(dropped).toEqual(["U7"]);
    expect(slack.messages).toHaveLength(1);
    const msg = slack.messages[0];
    expect(msg?.authorUserToken).toBeUndefined();
    expect(msg?.username).toBeUndefined(); // a review never wears the reviewer's face
    expect(JSON.stringify(msg?.blocks)).toContain("James Perkins");
  });

  it("ignores a review submitted by a bot", async () => {
    const botReview = review("approved");
    botReview.review.user.type = "Bot";
    await handleReview(deps(), reviewEvent(botReview));
    expect(slack.messages).toHaveLength(0);
  });

  it("cancels the reviewer's reminder, stamped by the review", async () => {
    await handleReview(deps(), reviewEvent(review("approved")));
    expect(await reminderRow()).toMatchObject({
      reviewerGithubId: 7,
      status: "cancelled",
      sourceUpdatedAt: new Date("2026-08-11T12:00:00Z"),
      sourceVersion: reviewArrival,
    });
  });

  it("cancels the reminder before a fallible Slack delivery", async () => {
    const requestedAt = new Date("2026-08-11T11:00:00Z");
    await scheduleReminder(db, {
      prId: prId("unkey/api", 1),
      reviewerGithubId: 7,
      dueAt: new Date("2026-08-11T23:00:00Z"),
      stamp: { updatedAt: requestedAt, version: "" },
    });
    slack.post = async () => {
      throw new Error("Slack unavailable");
    };

    await expect(handleReview(deps(), reviewEvent(review("approved")))).rejects.toThrow(
      "Slack unavailable",
    );
    expect((await reminderRow())?.status).toBe("cancelled");
  });

  it("reconciles the parent channel when a review arrives before opened", async () => {
    await db.delete(pullRequests);
    await handleReview(deps(), reviewEvent(review("approved")));
    expect(slack.channels).toHaveLength(1);
    expect(slack.messages.at(-1)?.channel).toBeDefined();
  });

  it("suppresses the empty 'commented' wrapper but still cancels the reminder", async () => {
    const emptyCommented = review("commented");
    emptyCommented.review.body = null; // inline-comments-only review, no summary text
    await handleReview(deps(), reviewEvent(emptyCommented));
    expect(slack.messages).toHaveLength(0); // no "💬 commented by …" noise
    expect((await reminderRow())?.status).toBe("cancelled"); // reminder still cancelled
  });

  it("posts a 'commented' review whose body is only a pasted image, with the image", async () => {
    const src = "https://github.com/user-attachments/assets/257e0ab0-5b6e-496e-9762-cedb27e67783";
    const embedImages = async (images: readonly { url: string; alt: string }[]) =>
      images.map((img) => ({ kind: "link" as const, sourceUrl: img.url, alt: img.alt }));
    const imageOnly = review("commented");
    imageOnly.review.body = `<img width="1512" height="982" alt="Broken layout" src="${src}" />`;

    await handleReview(deps({ embedImages }), reviewEvent(imageOnly));

    expect(slack.messages).toHaveLength(1);
    expect(slack.messages[0]?.images).toEqual([
      { kind: "link", sourceUrl: src, alt: "Broken layout" },
    ]);
  });

  it("still posts a 'commented' review that has body text", async () => {
    await handleReview(deps(), reviewEvent(review("commented"))); // body "looks good"
    expect(JSON.stringify(slack.messages.at(-1)?.blocks)).toContain("commented");
  });

  it("mirrors an allow-listed bot's review", async () => {
    const botReview = review("changes_requested");
    botReview.review.user.type = "Bot";
    botReview.review.user.login = "pullfrog[bot]";
    await handleReview(deps({ allowedBots: new Set(["pullfrog"]) }), reviewEvent(botReview));
    expect(slack.messages).toHaveLength(1);
  });

  it("threads a bot review under the PR root and cleans its HTML body", async () => {
    const botReview = review("commented");
    botReview.review.user.type = "Bot";
    botReview.review.user.login = "pullfrog[bot]";
    botReview.review.body =
      "Looks good overall.\n<!-- pullfrog meta -->\n<sup>marketing footer</sup>";
    await handleReview(deps({ allowedBots: new Set(["pullfrog"]) }), reviewEvent(botReview));
    const msg = slack.messages.at(-1);
    expect(msg?.threadTs).toBe("ts-root"); // threaded, not a top-level post
    const blocks = JSON.stringify(msg?.blocks);
    expect(blocks).toContain("Looks good overall.");
    expect(blocks).not.toContain("<!--");
    expect(blocks).not.toContain("marketing footer");
  });

  it("does not include CI or merge status in the review message", async () => {
    await handleReview(deps(), reviewEvent(review("approved")));
    const rendered = JSON.stringify(slack.messages);
    expect(rendered).toContain("approved");
    expect(rendered).toContain("looks good");
    expect(rendered).not.toContain("Ready to merge");
    expect(rendered).not.toContain("checks are failing");
    expect(rendered).not.toContain("mergeable");
  });

  it("does not alert a reviewer who already reviewed once CI passes", async () => {
    await applyPullRequestSource(db, {
      repoFullName: "unkey/api",
      number: 1,
      githubPrId: 1,
      currentState: "pr",
      headSha: "sha-1",
    });
    await handleReviewRequest(
      deps({ fetchCiReadiness: async () => "failing" }),
      pullRequestEvent({
        action: "review_requested",
        repository: { full_name: "unkey/api" },
        pull_request: review("approved").pull_request,
        requested_reviewer: { id: 7, login: "flo" },
      }),
      {
        arrivalKey: jobArrivalKey(new Date(0), "delivery-request"),
        attempt: 1,
        signal: new AbortController().signal,
      },
    );
    expect(slack.invites).toHaveLength(0);

    const submitted = review("approved");
    submitted.review.submitted_at = "2026-08-11T12:30:00Z";
    await handleReview(
      deps(),
      reviewEvent(submitted),
      jobArrivalKey(new Date(0), "delivery-review"),
    );
    const afterReview = slack.messages.length;

    await onCheckRun(
      deps({
        fetchCiReadiness: async () => "passing",
        fetchPullRequest: async () => ({
          mergeableState: "blocked",
          draft: false,
          requestedReviewers: [{ id: 7, login: "flo" }],
        }),
      }),
      checkRunEvent({
        action: "completed",
        repository: { full_name: "unkey/api" },
        check_run: {
          id: 100,
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/unkey/api/runs/100",
          head_sha: "sha-1",
          name: "test",
          pull_requests: [{ number: 1 }],
        },
      }),
      {
        arrivalKey: jobArrivalKey(new Date(0), "delivery-check"),
        attempt: 1,
        signal: new AbortController().signal,
      },
    );
    expect(slack.invites).toHaveLength(0);
    expect(slack.messages).toHaveLength(afterReview);
  });

  it("does not thread a human review", async () => {
    await handleReview(deps(), reviewEvent(review("approved")));
    expect(slack.messages.at(-1)?.threadTs).toBeUndefined();
  });
});

describe("onIssueComment (U6)", () => {
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
    await onIssueComment(deps(), issueCommentEvent(issueComment(true)));
    expect(slack.messages.at(-1)?.text).toContain("flo");
  });

  it("posts a conversation comment top-level, never threaded (GitHub has no threads here)", async () => {
    await onIssueComment(deps(), issueCommentEvent(issueComment(true)));
    expect(slack.messages.at(-1)?.threadTs).toBeUndefined();
  });

  it("authors a conversation comment as the linked Slack user", async () => {
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "flo",
      slackUserId: "U7",
      source: "self-link",
    });
    slack.profiles.set("U7", { name: "Flo Rider", iconUrl: "https://slack/a.png" });
    await onIssueComment(deps(), issueCommentEvent(issueComment(true)));
    const msg = slack.messages.at(-1);
    expect(msg?.username).toBe("Flo Rider");
    expect(msg?.iconUrl).toBe("https://slack/a.png");
    expect(JSON.stringify(msg?.blocks)).not.toContain("by flo"); // no redundant label
  });

  it("ignores a comment on a non-PR issue", async () => {
    expect(parseEvent("issue_comment", issueComment(false))).toMatchObject({
      kind: "ignored",
      reason: "not a PR",
    });
    expect(slack.messages).toHaveLength(0);
  });

  it("removes the mirrored message when a conversation comment is deleted", async () => {
    await onIssueComment(deps(), issueCommentEvent(issueComment(true)));
    const original = slack.messages.at(-1);
    expect(original).toBeDefined();

    const deleted = issueComment(true);
    deleted.action = "deleted";
    await onIssueComment(deps(), issueCommentEvent(deleted));

    expect(slack.deletes).toEqual([
      { channel: "C1", ts: original?.ts, authorUserToken: undefined },
    ]);
    expect(slack.messages.find((m) => m.ts === original?.ts)).toBeUndefined();
  });

  it("syncs an edit onto the existing Slack message in place", async () => {
    const created = issueComment(true);
    created.comment.body = "first draft";
    await onIssueComment(deps(), issueCommentEvent(created));
    const original = slack.messages.at(-1);
    const count = slack.messages.length;

    const edited = issueComment(true);
    edited.action = "edited";
    edited.comment.body = "second draft";
    await onIssueComment(deps(), issueCommentEvent(edited));

    expect(slack.messages).toHaveLength(count); // no new message
    expect(slack.updates).toHaveLength(1);
    const updated = slack.messages.find((m) => m.ts === original?.ts);
    expect(JSON.stringify(updated?.blocks)).toContain("second draft");
    expect(JSON.stringify(updated?.blocks)).not.toContain("first draft");
  });

  it("ignores comments from bots (Vercel/Mintlify, and our own bot)", async () => {
    const bot = issueComment(true);
    bot.comment.user.type = "Bot";
    await onIssueComment(deps(), issueCommentEvent(bot));
    expect(slack.messages).toHaveLength(0);
  });

  it("retries while another replica holds the PR's lease", async () => {
    await claimPullRequestLifecycle(db, 1, { now: new Date() });
    await expect(onIssueComment(deps(), issueCommentEvent(issueComment(true)))).rejects.toThrow(
      PullRequestLifecycleBusyError,
    );
    expect(slack.messages).toHaveLength(0);
  });

  it("builds a missing channel from GitHub's view of the PR, then mirrors (B2)", async () => {
    await db.delete(pullRequests);
    const fetched: string[] = [];
    const fetchSnapshot = async (repo: string, number: number) => {
      fetched.push(`${repo}#${number}`);
      return {
        snapshot: {
          repo,
          number: 1,
          githubPrId: 1,
          title: "Review me",
          url: "https://github.com/unkey/api/pull/1",
          author: { id: 100, login: "oz", isBot: false },
          draft: false,
          headSha: "sha-1",
          headRef: undefined,
          baseRef: undefined,
          updatedAt: "2026-08-11T12:00:00Z",
          requestedReviewers: [],
          state: "open" as const,
          merged: false,
        },
        remaining: 4999,
      };
    };

    await onIssueComment(deps({ fetchSnapshot }), issueCommentEvent(issueComment(true)));

    expect(fetched).toEqual(["unkey/api#1"]);
    expect(slack.channels).toHaveLength(1);
    const [root, comment] = slack.messages;
    expect(root?.text).toContain("Review me");
    expect(comment?.text).toContain("flo");
    expect(comment?.channel).toBe(slack.channels[0]?.id);
  });

  it("retries a PR comment whose PR GitHub cannot find yet", async () => {
    await db.delete(pullRequests);
    await expect(onIssueComment(deps(), issueCommentEvent(issueComment(true)))).rejects.toThrow(
      "PR channel is not ready",
    );
  });

  it("keeps the final rendered issue-comment section within Slack's limit", async () => {
    const input = issueComment(true);
    input.comment.body = `${"x\n".repeat(2_000)}<!channel>`;
    input.comment.user.login = "<!everyone>";
    await onIssueComment(deps(), issueCommentEvent(input));
    const block = slack.messages.at(-1)?.blocks?.[0] as { text?: { text?: string } };
    expect(block.text?.text?.length).toBeLessThanOrEqual(3_000);
    expect(JSON.stringify(slack.messages.at(-1))).not.toContain("<!channel>");
    expect(JSON.stringify(slack.messages.at(-1))).not.toContain("<!everyone>");
  });
});
