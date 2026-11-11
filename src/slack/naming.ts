import type { PrState } from "#events";

const MAX_LEN = 80;

interface NameParts {
  state: PrState;
  number: number;
  author: string;
}

interface Layout {
  before: string;
  after: string;
}

type LayoutFn = (parts: NameParts) => Layout;

// Each version wraps the truncatable repo slug. Rows keep the version they were created with.
const LAYOUTS = {
  1: ({ state, number }) => ({ before: `${state}-`, after: `-${number}` }),
  2: ({ state, author, number }) => ({ before: `${state}-${author}-`, after: `-${number}` }),
  3: ({ state, number, author }) => ({ before: `${state}-${number}-${author}-`, after: "" }),
} satisfies Record<number, LayoutFn>;

export const CURRENT_CHANNEL_NAME_VERSION = 3 satisfies keyof typeof LAYOUTS;

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
  const layout =
    (LAYOUTS as Record<number, LayoutFn | undefined>)[
      input.version ?? CURRENT_CHANNEL_NAME_VERSION
    ] ?? LAYOUTS[CURRENT_CHANNEL_NAME_VERSION];
  const author = slugify(input.author ?? "") || "unknown";
  const { before, after } = layout({ state, number, author });

  const repoBudget = Math.max(1, MAX_LEN - before.length - after.length);
  const repoSlug = (slugify(repoFullName) || "repo").slice(0, repoBudget).replace(/-+$/g, "");
  const base = `${before}${repoSlug}${after}`;

  const titleSlug = slugify(title);
  const titleBudget = MAX_LEN - base.length - 1;
  if (!titleSlug || titleBudget <= 1) return base;
  return `${base}-${titleSlug.slice(0, titleBudget).replace(/-+$/g, "")}`;
}
