import type { GithubActor } from "#events";

/** Normalize a bot login for matching: lowercase and drop GitHub's `[bot]` suffix. */
export function normalizeBotName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, "");
}

/**
 * Whether to skip mirroring an actor's comment/review. Humans are never skipped.
 * Bots (Vercel, Mintlify, Dependabot, our own App) are noisy, often raw markdown
 * deploy previews, so a bot is skipped unless its normalized login is in
 * `allowedBots` (ALLOWED_BOTS), letting a workspace surface a chosen review bot.
 */
export function shouldSkipActor(
  actor: Pick<GithubActor, "isBot" | "login">,
  allowedBots: ReadonlySet<string> = new Set(),
): boolean {
  if (!actor.isBot) return false;
  const login = normalizeBotName(actor.login);
  return !(login && allowedBots.has(login));
}
