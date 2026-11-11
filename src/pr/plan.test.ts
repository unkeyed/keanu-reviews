import { describe, expect, it } from "vitest";
import { type PrSnapshot, jobArrivalKey } from "#events";
import {
  type ChannelFeatures,
  type ChannelStep,
  type ConvergeCause,
  type PlanRecord,
  planChannel,
} from "./plan.ts";

const snapshot = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  repo: "unkey/api",
  number: 1423,
  githubPrId: 999,
  title: "Add auth",
  url: "https://github.com/unkey/api/pull/1423",
  author: { id: 100, login: "oz", isBot: false },
  draft: false,
  headSha: "sha1",
  headRef: undefined,
  baseRef: undefined,
  updatedAt: "2026-08-11T12:00:00Z",
  requestedReviewers: [],
  ...over,
});

const record = (over: Partial<PlanRecord> = {}): PlanRecord => ({
  repoFullName: "unkey/api",
  number: 1423,
  currentState: "pr",
  appliedState: "pr",
  appliedChannelName: "pr-oz-unkey-api-1423-add-auth",
  channelId: "C1",
  rootMessageTs: "ts-1",
  channelNameVersion: 2,
  ...over,
});

const fresh = (state: PlanRecord["currentState"]) =>
  record({
    currentState: state,
    appliedState: null,
    appliedChannelName: null,
    channelId: null,
    rootMessageTs: null,
    channelNameVersion: 1,
  });

const arrivalKey = jobArrivalKey(new Date("2026-08-11T12:00:01Z"), "job");
const webhook = (action: string, merged = false): ConvergeCause => ({
  kind: "pull_request",
  action,
  merged,
  arrivalKey,
});
const reconcile = (merged: boolean): ConvergeCause => ({ kind: "reconcile", merged, arrivalKey });
const child: ConvergeCause = { kind: "child" };

const none: ChannelFeatures = { shipped: false, commentOnMerge: false, quietLeave: false };
const all: ChannelFeatures = { shipped: true, commentOnMerge: true, quietLeave: true };

const author: ChannelStep[] = [{ kind: "resolve-author" }, { kind: "invite-author" }];
const name = (state: string, title = "add-auth") => `${state}-oz-unkey-api-1423-${title}`;

interface Row {
  record: PlanRecord;
  cause: ConvergeCause;
  snapshot?: Partial<PrSnapshot>;
  features?: ChannelFeatures;
  steps: ChannelStep[];
}

const table: Record<string, Row> = {
  "opened creates the channel, posts the root, invites the author, then applies the same name": {
    record: fresh("pr"),
    cause: webhook("opened"),
    steps: [
      { kind: "create", name: name("pr") },
      { kind: "post-root" },
      ...author,
      { kind: "rename", name: name("pr") },
      { kind: "mark-applied", from: null, state: "pr", name: name("pr") },
    ],
  },
  "an opened draft creates a draft- channel": {
    record: fresh("draft"),
    cause: webhook("opened"),
    snapshot: { draft: true },
    steps: [
      { kind: "create", name: name("draft") },
      { kind: "post-root" },
      ...author,
      { kind: "rename", name: name("draft") },
      { kind: "mark-applied", from: null, state: "draft", name: name("draft") },
    ],
  },
  "a missing channel is created on the current scheme even for a v1 row": {
    record: { ...fresh("pr"), channelNameVersion: 1, appliedChannelName: "pr-unkey-api-1423" },
    cause: webhook("opened"),
    steps: [
      { kind: "create", name: name("pr") },
      { kind: "post-root" },
      ...author,
      { kind: "rename", name: name("pr") },
      { kind: "mark-applied", from: null, state: "pr", name: name("pr") },
    ],
  },
  "a non-lifecycle event on an applied channel only re-checks the author invite": {
    record: record(),
    cause: webhook("synchronize"),
    steps: author,
  },
  "a lifecycle action on an applied channel threads its note under the root": {
    record: record(),
    cause: webhook("opened"),
    steps: [...author, { kind: "lifecycle-note", action: "opened", state: "pr" }],
  },
  "ready_for_review renames, then notes, then marks applied": {
    record: record({ appliedState: "draft", appliedChannelName: name("draft") }),
    cause: webhook("ready_for_review"),
    steps: [
      ...author,
      { kind: "rename", name: name("pr") },
      { kind: "lifecycle-note", action: "ready_for_review", state: "pr" },
      { kind: "mark-applied", from: "draft", state: "pr", name: name("pr") },
    ],
  },
  "a synchronize that heals a stuck draft renames without a note": {
    record: record({ appliedState: "draft", appliedChannelName: name("draft") }),
    cause: webhook("synchronize"),
    steps: [
      ...author,
      { kind: "rename", name: name("pr") },
      { kind: "mark-applied", from: "draft", state: "pr", name: name("pr") },
    ],
  },
  "converted_to_draft renames back with a note": {
    record: record({ currentState: "draft" }),
    cause: webhook("converted_to_draft"),
    snapshot: { draft: true },
    steps: [
      ...author,
      { kind: "rename", name: name("draft") },
      { kind: "lifecycle-note", action: "converted_to_draft", state: "draft" },
      { kind: "mark-applied", from: "pr", state: "draft", name: name("draft") },
    ],
  },
  "a close cancels reminders before Slack, renames, notes, then archives": {
    record: record({ currentState: "closed" }),
    cause: webhook("closed"),
    features: all,
    steps: [
      ...author,
      { kind: "cancel-reminders" },
      { kind: "unarchive" },
      { kind: "rename", name: name("closed") },
      { kind: "lifecycle-note", action: "closed", state: "closed" },
      { kind: "quiet-leave" },
      { kind: "archive" },
      { kind: "mark-applied", from: "pr", state: "closed", name: name("closed") },
    ],
  },
  "a merge leaves quietly, archives, then announces": {
    record: record({ currentState: "merged" }),
    cause: webhook("closed", true),
    features: all,
    steps: [
      ...author,
      { kind: "cancel-reminders" },
      { kind: "unarchive" },
      { kind: "rename", name: name("merged") },
      { kind: "lifecycle-note", action: "closed", state: "merged" },
      { kind: "quiet-leave" },
      { kind: "archive" },
      { kind: "announce-shipped" },
      { kind: "comment-on-merge" },
      { kind: "mark-applied", from: "pr", state: "merged", name: name("merged") },
    ],
  },
  "a merge without features archives without leaving or announcing": {
    record: record({ currentState: "merged" }),
    cause: webhook("closed", true),
    steps: [
      ...author,
      { kind: "cancel-reminders" },
      { kind: "unarchive" },
      { kind: "rename", name: name("merged") },
      { kind: "lifecycle-note", action: "closed", state: "merged" },
      { kind: "archive" },
      { kind: "mark-applied", from: "pr", state: "merged", name: name("merged") },
    ],
  },
  "a reconcile merge archives but skips both announcements": {
    record: record({ currentState: "merged" }),
    cause: reconcile(true),
    features: all,
    steps: [
      ...author,
      { kind: "cancel-reminders" },
      { kind: "unarchive" },
      { kind: "rename", name: name("merged") },
      { kind: "lifecycle-note", action: "closed", state: "merged" },
      { kind: "quiet-leave" },
      { kind: "archive" },
      { kind: "skip-announcements", shipped: true, mergeComment: true },
      { kind: "mark-applied", from: "pr", state: "merged", name: name("merged") },
    ],
  },
  "a reconcile merge with announcements off has nothing to skip": {
    record: record({ currentState: "merged" }),
    cause: reconcile(true),
    steps: [
      ...author,
      { kind: "cancel-reminders" },
      { kind: "unarchive" },
      { kind: "rename", name: name("merged") },
      { kind: "lifecycle-note", action: "closed", state: "merged" },
      { kind: "archive" },
      { kind: "mark-applied", from: "pr", state: "merged", name: name("merged") },
    ],
  },
  "a reconcile close announces nothing": {
    record: record({ currentState: "closed" }),
    cause: reconcile(false),
    features: all,
    steps: [
      ...author,
      { kind: "cancel-reminders" },
      { kind: "unarchive" },
      { kind: "rename", name: name("closed") },
      { kind: "lifecycle-note", action: "closed", state: "closed" },
      { kind: "quiet-leave" },
      { kind: "archive" },
      { kind: "mark-applied", from: "pr", state: "closed", name: name("closed") },
    ],
  },
  "a later event on an archived merged PR writes nothing to the channel": {
    record: record({
      currentState: "merged",
      appliedState: "merged",
      appliedChannelName: name("merged"),
    }),
    cause: webhook("edited"),
    features: all,
    steps: [{ kind: "cancel-reminders" }],
  },
  "a redelivered close of an archived channel posts no note": {
    record: record({
      currentState: "closed",
      appliedState: "closed",
      appliedChannelName: name("closed"),
    }),
    cause: webhook("closed"),
    steps: [{ kind: "cancel-reminders" }],
  },
  "a title edit after a merge reopens the archive only to rename it": {
    record: record({
      currentState: "merged",
      appliedState: "merged",
      appliedChannelName: name("merged"),
    }),
    cause: webhook("edited"),
    snapshot: { title: "Add better auth" },
    steps: [
      { kind: "cancel-reminders" },
      { kind: "unarchive" },
      { kind: "rename", name: name("merged", "add-better-auth") },
      { kind: "archive" },
      {
        kind: "mark-applied",
        from: "merged",
        state: "merged",
        name: name("merged", "add-better-auth"),
      },
    ],
  },
  "a rename after a merge still resolves the author the #shipped post may name": {
    record: record({
      currentState: "merged",
      appliedState: "merged",
      appliedChannelName: name("merged"),
    }),
    cause: webhook("edited"),
    snapshot: { title: "Add better auth" },
    features: { shipped: true, commentOnMerge: false, quietLeave: false },
    steps: [
      { kind: "resolve-author" },
      { kind: "cancel-reminders" },
      { kind: "unarchive" },
      { kind: "rename", name: name("merged", "add-better-auth") },
      { kind: "archive" },
      { kind: "announce-shipped" },
      {
        kind: "mark-applied",
        from: "merged",
        state: "merged",
        name: name("merged", "add-better-auth"),
      },
    ],
  },
  "a reopen unarchives before the author invite, and again before the rename": {
    record: record({ appliedState: "closed", appliedChannelName: name("closed") }),
    cause: webhook("reopened"),
    steps: [
      { kind: "unarchive" },
      ...author,
      { kind: "unarchive" },
      { kind: "rename", name: name("pr") },
      { kind: "lifecycle-note", action: "reopened", state: "pr" },
      { kind: "mark-applied", from: "closed", state: "pr", name: name("pr") },
    ],
  },
  "a terminal-first event creates, roots, renames and archives without a note": {
    record: fresh("merged"),
    cause: webhook("closed", true),
    steps: [
      { kind: "create", name: name("merged") },
      { kind: "post-root" },
      ...author,
      { kind: "cancel-reminders" },
      { kind: "unarchive" },
      { kind: "rename", name: name("merged") },
      { kind: "archive" },
      { kind: "mark-applied", from: null, state: "merged", name: name("merged") },
    ],
  },
  "a root that failed to post is posted first on retry, with no note": {
    record: { ...fresh("merged"), channelId: "C1", channelNameVersion: 2 },
    cause: webhook("closed", true),
    steps: [
      { kind: "post-root" },
      ...author,
      { kind: "cancel-reminders" },
      { kind: "unarchive" },
      { kind: "rename", name: name("merged") },
      { kind: "archive" },
      { kind: "mark-applied", from: null, state: "merged", name: name("merged") },
    ],
  },
  "a repository rename renames the channel without a note": {
    record: record({ repoFullName: "unkey/platform" }),
    cause: webhook("edited"),
    steps: [
      ...author,
      { kind: "rename", name: "pr-oz-unkey-platform-1423-add-auth" },
      {
        kind: "mark-applied",
        from: "pr",
        state: "pr",
        name: "pr-oz-unkey-platform-1423-add-auth",
      },
    ],
  },
  "a legacy v1 channel renames within its author-less scheme": {
    record: record({ channelNameVersion: 1, appliedChannelName: "pr-unkey-api-1423-add-auth" }),
    cause: webhook("edited"),
    snapshot: { title: "Add better auth" },
    steps: [
      ...author,
      { kind: "rename", name: "pr-unkey-api-1423-add-better-auth" },
      { kind: "mark-applied", from: "pr", state: "pr", name: "pr-unkey-api-1423-add-better-auth" },
    ],
  },
  "a child event for a new PR builds the channel and root, never a note": {
    record: fresh("pr"),
    cause: child,
    steps: [
      { kind: "create", name: name("pr") },
      { kind: "post-root" },
      ...author,
      { kind: "rename", name: name("pr") },
      { kind: "mark-applied", from: null, state: "pr", name: name("pr") },
    ],
  },
  "a child event finishing an interrupted merge still announces it": {
    record: { ...record({ currentState: "merged" }), rootMessageTs: null },
    cause: child,
    features: all,
    steps: [
      { kind: "post-root" },
      ...author,
      { kind: "cancel-reminders" },
      { kind: "unarchive" },
      { kind: "rename", name: name("merged") },
      { kind: "quiet-leave" },
      { kind: "archive" },
      { kind: "announce-shipped" },
      { kind: "comment-on-merge" },
      { kind: "mark-applied", from: "pr", state: "merged", name: name("merged") },
    ],
  },
};

describe("planChannel", () => {
  it.each(Object.entries(table))("%s", (_, row) => {
    expect(
      planChannel(row.record, snapshot(row.snapshot), row.cause, row.features ?? none),
    ).toEqual(row.steps);
  });
});
