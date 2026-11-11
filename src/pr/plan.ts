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

export type ConvergeCause =
  | { kind: "pull_request"; action: string; merged: boolean; arrivalKey: ArrivalKey }
  | { kind: "child" }
  | { kind: "reconcile"; merged: boolean; arrivalKey: ArrivalKey };

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

export function planChannel(
  record: PlanRecord,
  snapshot: PrSnapshot,
  cause: ConvergeCause,
  features: ChannelFeatures,
): ChannelStep[] {
  const steps: ChannelStep[] = [];
  const create = !record.channelId;
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

function resolveAuthorOnlyIfUsed(steps: ChannelStep[]): ChannelStep[] {
  const used = steps.some((s) => s.kind === "invite-author" || s.kind === "announce-shipped");
  return used ? steps : steps.filter((s) => s.kind !== "resolve-author");
}

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
