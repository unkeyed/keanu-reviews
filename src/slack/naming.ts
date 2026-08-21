import type { PrState } from "../domain/prState.ts";

/**
 * Channel naming (KTD7).
 *
 * v1 (legacy): `<state>-<repo-slug>-<number>-<title-slug>`
 *   e.g. `pr-unkey-api-1423-add-auth`.
 * v2 (current): `<state>-<author-slug>-<repo-slug>-<number>-<title-slug>`
 *   e.g. `pr-alice-unkey-api-1423-add-auth`.
 *
 * All names are lowercased/slugified to satisfy Slack's <=80 char, lowercase,
 * [a-z0-9-_] constraint. The `<state>-…-<repo>-<number>` head uniquely
 * identifies a PR (numbers are unique per repo); the title is appended for
 * readability and trimmed to fit.
 *
 * The scheme version is stamped on a PR when its channel is first created and
 * reused for every later rename, so channels created before v2 keep their
 * original (author-less) name for life while all new channels adopt v2. The
 * channel is addressed by stored id, never re-derived, so a later title/state
 * edit simply renames the channel within its own scheme.
 */
const MAX_LEN = 80;

/** Naming scheme applied to channels created from now on. */
export const CURRENT_CHANNEL_NAME_VERSION = 2;

export interface ChannelNameInput {
  state: PrState;
  repoFullName: string;
  number: number;
  title: string;
  /** PR author's GitHub login; used by v2+ only. */
  author?: string | null;
  /** Naming scheme; defaults to the current version. */
  version?: number;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function channelName(input: ChannelNameInput): string {
  const { state, repoFullName, number, title } = input;
  const version = input.version ?? CURRENT_CHANNEL_NAME_VERSION;

  // v2+ inserts the slugified author between the state and the repo. v1 keeps
  // the original author-less prefix byte-for-byte for backwards compatibility.
  const authorPart = version >= 2 ? `${slugify(input.author ?? "") || "unknown"}-` : "";
  const prefix = `${state}-${authorPart}`;
  const numberPart = `-${number}`;
  // Keep the full number; truncate the repo slug only if the two together
  // would exceed the limit (rare — repo names are short).
  const repoBudget = Math.max(1, MAX_LEN - prefix.length - numberPart.length);
  const repoSlug = (slugify(repoFullName) || "repo").slice(0, repoBudget).replace(/-+$/g, "");
  const base = `${prefix}${repoSlug}${numberPart}`; // e.g. pr-alice-unkey-api-1423

  const titleSlug = slugify(title);
  const titleBudget = MAX_LEN - base.length - 1; // 1 for the joining dash
  if (!titleSlug || titleBudget <= 1) return base;
  return `${base}-${titleSlug.slice(0, titleBudget).replace(/-+$/g, "")}`;
}
