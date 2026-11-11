import {
  type PrSnapshot,
  type PrState,
  type StateClaim,
  claimFromAction,
  isTerminal,
} from "#events";
import type { ArrivalKey } from "#lib";
import { CURRENT_CHANNEL_NAME_VERSION, channelName } from "#slack";
import type { PrRow } from "./store.ts";

/**
 * Why a PR's channel converges. Every per-trigger difference derives from it.
 * - `pull_request`: a lifecycle webhook. Its action may assert the state and
 *   post a lifecycle note, and a merge is announced.
 * - `child`: the PR object inside a review or review comment. It only hints at
 *   draft and carries no arrival key. It builds a missing channel or root, and
 *   an open PR's channel follows a strictly newer one's title and draft flag.
 * - `reconcile`: the daily catch-up of a close GitHub already reported. It
 *   archives like the webhook would but announces nothing.
 */
export type ConvergeCause =
  | { kind: "pull_request"; action: string; merged: boolean; arrivalKey: ArrivalKey }
  | { kind: "child" }
  | { kind: "reconcile"; merged: boolean; arrivalKey: ArrivalKey };

/** The action a cause stands for; lifecycle note keys embed it. */
function causeAction(cause: ConvergeCause): string {
  switch (cause.kind) {
    case "pull_request":
      return cause.action;
    case "child":
      return "synchronize";
    case "reconcile":
      return "closed";
  }
}

export function causeClaim(cause: ConvergeCause, snapshot: PrSnapshot): StateClaim {
  const merged = cause.kind === "child" ? false : cause.merged;
  return claimFromAction(causeAction(cause), snapshot.draft, merged);
}

/** One ordered step of channel convergence; the executor runs them in order. */
export type ChannelStep =
  | { kind: "create"; name: string }
  | { kind: "unarchive" }
  | { kind: "post-root" }
  | { kind: "resolve-author" }
  | { kind: "invite-author" }
  | { kind: "cancel-reminders" }
  | { kind: "rename"; name: string }
  | { kind: "lifecycle-note"; action: string; state: PrState }
  | { kind: "quiet-leave" }
  | { kind: "archive" }
  | { kind: "announce-shipped" }
  | { kind: "comment-on-merge" }
  | { kind: "skip-announcements"; shipped: boolean; mergeComment: boolean }
  | { kind: "mark-applied"; from: PrState | null; state: PrState; name: string };

/** Configured features that add steps. */
export interface ChannelFeatures {
  shipped: boolean;
  commentOnMerge: boolean;
  quietLeave: boolean;
}

export type PlanRecord = Pick<
  PrRow,
  | "repoFullName"
  | "number"
  | "currentState"
  | "appliedState"
  | "appliedChannelName"
  | "channelId"
  | "rootMessageTs"
  | "channelNameVersion"
>;

/**
 * The channel decision table for a stored PR whose snapshot was accepted.
 * An archived channel that stays terminal gets no writes; one the PR leaves
 * is unarchived first. The lifecycle note goes only to a channel that already
 * had its root, and before the archive inside a transition. A terminal PR
 * cancels its reminders before any Slack transition, and renames before it
 * archives.
 */
export function planChannel(
  record: PlanRecord,
  snapshot: PrSnapshot,
  cause: ConvergeCause,
  features: ChannelFeatures,
): ChannelStep[] {
  const steps: ChannelStep[] = [];
  const create = !record.channelId;
  // A channel keeps the naming scheme it was created with, so legacy v1 names never churn.
  const version = create ? CURRENT_CHANNEL_NAME_VERSION : record.channelNameVersion;
  const desired = record.currentState;
  const name = channelName({
    version,
    state: desired,
    repoFullName: record.repoFullName,
    number: record.number,
    title: snapshot.title,
    author: snapshot.author.login,
  });
  if (create) steps.push({ kind: "create", name });

  const wasArchived = record.appliedState !== null && isTerminal(record.appliedState);
  const stayingArchived = wasArchived && isTerminal(desired);
  if (wasArchived && !stayingArchived) steps.push({ kind: "unarchive" });

  const hasRoot = !create && Boolean(record.rootMessageTs);
  if (!hasRoot && !stayingArchived) steps.push({ kind: "post-root" });

  steps.push({ kind: "resolve-author" });
  if (!stayingArchived) steps.push({ kind: "invite-author" });

  if (isTerminal(desired)) steps.push({ kind: "cancel-reminders" });

  const note: ChannelStep[] =
    hasRoot && causeClaim(cause, snapshot).kind === "asserted"
      ? [{ kind: "lifecycle-note", action: causeAction(cause), state: desired }]
      : [];

  if (record.appliedState === desired && record.appliedChannelName === name) {
    if (!stayingArchived) steps.push(...note);
    return resolveAuthorOnlyIfUsed(steps);
  }

  if (isTerminal(desired) || wasArchived) steps.push({ kind: "unarchive" });
  steps.push({ kind: "rename", name }, ...note);
  if (isTerminal(desired)) {
    if (features.quietLeave) steps.push({ kind: "quiet-leave" });
    steps.push({ kind: "archive" });
    if (desired === "merged") steps.push(...announcements(cause, features));
  }
  steps.push({ kind: "mark-applied", from: record.appliedState, state: desired, name });
  return resolveAuthorOnlyIfUsed(steps);
}

/**
 * Resolving the author can read GitHub and Slack and record an email-match
 * identity, so a plan resolves them only for a step that names them: the
 * invite, or the #shipped post. A channel that stays archived has neither.
 */
function resolveAuthorOnlyIfUsed(steps: ChannelStep[]): ChannelStep[] {
  const used = steps.some((s) => s.kind === "invite-author" || s.kind === "announce-shipped");
  return used ? steps : steps.filter((s) => s.kind !== "resolve-author");
}

/** A late catch-up skips both merge announcements; the archive itself still happens. */
function announcements(cause: ConvergeCause, features: ChannelFeatures): ChannelStep[] {
  const { shipped, commentOnMerge } = features;
  if (cause.kind === "reconcile") {
    return shipped || commentOnMerge
      ? [{ kind: "skip-announcements", shipped, mergeComment: commentOnMerge }]
      : [];
  }
  const steps: ChannelStep[] = [];
  if (shipped) steps.push({ kind: "announce-shipped" });
  if (commentOnMerge) steps.push({ kind: "comment-on-merge" });
  return steps;
}
