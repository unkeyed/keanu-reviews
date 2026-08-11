import type { PrState } from "../domain/prState.ts";

/**
 * Channel naming (KTD7). Pattern `<state>-<repo-slug>-<number>`, lowercased and
 * slugified to satisfy Slack's <=80 char, lowercase, [a-z0-9-_] constraint. The
 * channel is addressed by stored id, never re-derived — but the name still has to
 * be valid and stable, and long repo names must be truncated, not rejected.
 */
const MAX_LEN = 80;

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function channelName(state: PrState, repoFullName: string, number: number): string {
  // Use only the repo name (after the owner slash) to keep names short.
  const repo = repoFullName.includes("/")
    ? (repoFullName.split("/").pop() ?? repoFullName)
    : repoFullName;
  const suffix = `-${number}`;
  const prefix = `${state}-`;
  const budget = MAX_LEN - prefix.length - suffix.length;
  const repoSlug = slugify(repo).slice(0, Math.max(1, budget)).replace(/-+$/g, "");
  return `${prefix}${repoSlug}${suffix}`;
}
