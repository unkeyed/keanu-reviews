import type { PrState } from "../domain/prState.ts";

/**
 * Channel naming (KTD7). Pattern `<state>-<repo-slug>-<number>-<title-slug>`,
 * lowercased and slugified to satisfy Slack's <=80 char, lowercase, [a-z0-9-_]
 * constraint. `<state>-<repo>-<number>` uniquely identifies a PR (numbers are
 * unique per repo); the title is appended for readability and trimmed to fit.
 *
 * The channel is addressed by stored id, never re-derived, so a later title edit
 * simply renames the channel. (Two distinct repos whose slugs collapse to the
 * same value — e.g. `go.sdk` vs `go-sdk` — with the same PR number would share a
 * name; that does not occur within a single org/installation.)
 */
const MAX_LEN = 80;

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function channelName(
  state: PrState,
  repoFullName: string,
  number: number,
  title: string,
): string {
  const prefix = `${state}-`;
  const numberPart = `-${number}`;
  // Keep the full number; truncate the repo slug only if the two together
  // would exceed the limit (rare — repo names are short).
  const repoBudget = Math.max(1, MAX_LEN - prefix.length - numberPart.length);
  const repoSlug = (slugify(repoFullName) || "repo").slice(0, repoBudget).replace(/-+$/g, "");
  const base = `${prefix}${repoSlug}${numberPart}`; // e.g. pr-unkey-api-1423

  const titleSlug = slugify(title);
  const titleBudget = MAX_LEN - base.length - 1; // 1 for the joining dash
  if (!titleSlug || titleBudget <= 1) return base;
  return `${base}-${titleSlug.slice(0, titleBudget).replace(/-+$/g, "")}`;
}
