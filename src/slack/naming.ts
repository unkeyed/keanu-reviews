import type { PrState } from "#events";

const MAX_LEN = 80;

export const CURRENT_CHANNEL_NAME_VERSION = 2;

export interface ChannelNameInput {
  state: PrState;
  repoFullName: string;
  number: number;
  title: string;
  author?: string | null;
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

  const authorPart = version >= 2 ? `${slugify(input.author ?? "") || "unknown"}-` : "";
  const prefix = `${state}-${authorPart}`;
  const numberPart = `-${number}`;
  const repoBudget = Math.max(1, MAX_LEN - prefix.length - numberPart.length);
  const repoSlug = (slugify(repoFullName) || "repo").slice(0, repoBudget).replace(/-+$/g, "");
  const base = `${prefix}${repoSlug}${numberPart}`;

  const titleSlug = slugify(title);
  const titleBudget = MAX_LEN - base.length - 1;
  if (!titleSlug || titleBudget <= 1) return base;
  return `${base}-${titleSlug.slice(0, titleBudget).replace(/-+$/g, "")}`;
}
