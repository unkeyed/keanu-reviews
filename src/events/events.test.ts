import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type PrState,
  type StateClaim,
  claimFromAction,
  jobPrKeys,
  nextState,
  parseEvent,
} from "#events";
import { Permanent } from "#lib";

const FIXTURES = join(
  import.meta.dirname,
  "../../.claude/skills/verify-keanu-reviews/fixtures/payloads",
);

/** Fixture names start with the event they replay. Longest prefix wins. */
const EVENT_BY_PREFIX: [string, string][] = [
  ["review-comment", "pull_request_review_comment"],
  ["issue-comment", "issue_comment"],
  ["check-run", "check_run"],
  ["review", "pull_request_review"],
  ["pr", "pull_request"],
];

const fixtures = (() => {
  try {
    return readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
})();

describe("parseEvent on recorded payloads", () => {
  it.skipIf(fixtures.length === 0)("accepts every verify fixture as a handled event", () => {
    for (const file of fixtures) {
      const name = file.replace(/\.json$/, "");
      const event = EVENT_BY_PREFIX.find(([p]) => name === p || name.startsWith(`${p}-`))?.[1];
      expect(event, file).toBeDefined();
      const raw = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
      const parsed = parseEvent(event as string, raw);
      expect(parsed.kind, file).not.toBe("ignored");
    }
  });
});

const pr = {
  number: 7,
  id: 70,
  title: "Fix it",
  html_url: "https://github.com/acme/api/pull/7",
  user: { login: "oz", id: 100, type: "User" },
  head: { sha: "abc", ref: "oz/fix" },
  base: { ref: "main" },
  draft: false,
  merged: true,
  updated_at: "2026-08-11T12:00:00Z",
  requested_reviewers: [{ login: "flo", id: 7, type: "User" }],
};
const repository = { full_name: "acme/api" };

describe("parseEvent", () => {
  it("builds one PR snapshot from a pull_request payload", () => {
    expect(parseEvent("pull_request", { action: "closed", repository, pull_request: pr })).toEqual({
      kind: "pull_request",
      action: "closed",
      merged: true,
      requestedReviewer: undefined,
      requestedTeam: undefined,
      pr: {
        repo: "acme/api",
        number: 7,
        githubPrId: 70,
        title: "Fix it",
        url: "https://github.com/acme/api/pull/7",
        author: { id: 100, login: "oz", isBot: false },
        draft: false,
        headSha: "abc",
        headRef: "oz/fix",
        baseRef: "main",
        updatedAt: "2026-08-11T12:00:00Z",
        requestedReviewers: [{ id: 7, login: "flo", isBot: false }],
      },
    });
  });

  it("reads team-only and individual review requests, treating an untyped actor as human", () => {
    const ev = parseEvent("pull_request", {
      action: "review_requested",
      repository,
      pull_request: { ...pr, user: { login: "dependabot[bot]", id: 9, type: "Bot" } },
      requested_team: { id: 1, slug: "core" },
    });
    expect(ev).toMatchObject({
      requestedReviewer: undefined,
      requestedTeam: "core",
      pr: { author: { isBot: true } },
    });

    const untyped = parseEvent("pull_request", {
      action: "review_requested",
      repository,
      pull_request: pr,
      requested_reviewer: { id: 7, login: "flo" },
    });
    expect(untyped).toMatchObject({ requestedReviewer: { id: 7, login: "flo", isBot: false } });
  });

  it("defaults the optional review and comment fields", () => {
    const review = parseEvent("pull_request_review", {
      action: "submitted",
      repository,
      pull_request: pr,
      review: { id: 1, state: "approved", body: null, html_url: "u", user: pr.user },
    });
    expect(review).toMatchObject({ review: { body: "", submittedAt: undefined } });

    const comment = parseEvent("pull_request_review_comment", {
      action: "created",
      repository,
      pull_request: pr,
      comment: { id: 2, path: "a.ts", body: "b", html_url: "u", user: pr.user },
    });
    expect(comment).toMatchObject({ comment: { inReplyTo: undefined, line: null } });
  });

  it("ignores unknown events and actions no handler acts on", () => {
    const cases: [string, unknown, string][] = [
      ["ping", { zen: "hi" }, "unknown event"],
      ["installation", null, "unknown event"],
      ["pull_request_review", { action: "dismissed" }, "unhandled action"],
      ["pull_request_review_comment", { action: "resolved" }, "unhandled action"],
      ["issue_comment", { action: "pinned", issue: { pull_request: {} } }, "unhandled action"],
      ["issue_comment", { action: "created", issue: { number: 3 } }, "not a PR"],
      [
        "check_run",
        { action: "created", check_run: { status: "in_progress" } },
        "check run not completed",
      ],
    ];
    for (const [event, raw, reason] of cases) {
      expect(parseEvent(event, raw), event).toMatchObject({ kind: "ignored", event, reason });
    }
  });

  it("fails permanently, naming the field, when a handled payload is malformed", () => {
    const run = () =>
      parseEvent("pull_request", {
        action: "opened",
        repository,
        pull_request: { ...pr, updated_at: "not a date" },
      });
    expect(run).toThrow(Permanent);
    try {
      run();
    } catch (err) {
      expect((err as Permanent).details).toEqual({
        issues: ["pull_request.updated_at: must be a timestamp"],
      });
    }
    expect(() => parseEvent("check_run", { check_run: { status: "completed" } })).toThrow(
      Permanent,
    );
  });
});

describe("nextState", () => {
  const asserted = (state: PrState): StateClaim => ({ kind: "asserted", state });

  it("lets a lifecycle action dictate the state", () => {
    expect(claimFromAction("opened", true, false)).toEqual(asserted("draft"));
    expect(claimFromAction("reopened", false, false)).toEqual(asserted("pr"));
    expect(claimFromAction("ready_for_review", true, false)).toEqual(asserted("pr"));
    expect(claimFromAction("converted_to_draft", false, false)).toEqual(asserted("draft"));
    expect(claimFromAction("closed", false, true)).toEqual(asserted("merged"));
    expect(claimFromAction("closed", false, false)).toEqual(asserted("closed"));
    expect(nextState("merged", asserted("pr"))).toBe("pr");
  });

  it("derives the open state from the draft fact for every other action", () => {
    const hint = claimFromAction("synchronize", false, false);
    expect(hint).toEqual({ kind: "open-hint", draft: false });
    expect(nextState("draft", hint)).toBe("pr");
    expect(nextState(undefined, claimFromAction("edited", true, false))).toBe("draft");
  });

  it("never revives a closed or merged PR from a non-lifecycle action", () => {
    expect(nextState("closed", { kind: "open-hint", draft: false })).toBe("closed");
    expect(nextState("merged", { kind: "open-hint", draft: true })).toBe("merged");
  });
});

describe("jobPrKeys", () => {
  const repository = { full_name: "Unkey/API" };

  it("names the one PR a PR, review, review comment or PR comment event is about", () => {
    const pr = { repository, pull_request: { number: 7 } };
    expect(jobPrKeys("pull_request", pr)).toEqual(["unkey/api#7"]);
    expect(jobPrKeys("pull_request_review", pr)).toEqual(["unkey/api#7"]);
    expect(jobPrKeys("pull_request_review_comment", pr)).toEqual(["unkey/api#7"]);
    expect(jobPrKeys("issue_comment", { repository, issue: { number: 7 } })).toEqual([
      "unkey/api#7",
    ]);
  });

  it("names every PR a check run lists, and none for a fork's run or a non-PR event", () => {
    const run = (numbers: number[]) => ({
      repository,
      check_run: { pull_requests: numbers.map((number) => ({ number })) },
    });
    expect(jobPrKeys("check_run", run([7, 9, 7]))).toEqual(["unkey/api#7", "unkey/api#9"]);
    expect(jobPrKeys("check_run", run([]))).toEqual([]);
    expect(jobPrKeys("installation", { repository })).toEqual([]);
    expect(jobPrKeys("pull_request", null)).toEqual([]);
    expect(jobPrKeys("pull_request", { repository, pull_request: { number: "7" } })).toEqual([]);
  });
});
