import { createHash } from "node:crypto";
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
  // Include owner + repo and retain a digest of the original identity. The
  // digest prevents slug/truncation collisions while exact lookup remains safe.
  const identityHash = createHash("sha256")
    .update(`${repoFullName.toLowerCase()}#${number}`)
    .digest("hex")
    .slice(0, 8);
  const suffix = `-${number}-${identityHash}`;
  const prefix = `${state}-`;
  const budget = MAX_LEN - prefix.length - suffix.length;
  const repoSlug = (slugify(repoFullName) || "repo")
    .slice(0, Math.max(1, budget))
    .replace(/-+$/g, "");
  return `${prefix}${repoSlug}${suffix}`;
}
