/**
 * GitHub marks automation accounts (Vercel, Mintlify, Dependabot, our own App's
 * bot, …) with `type: "Bot"` on the user object. By default we skip mirroring
 * their comments/reviews — they're noisy (often raw markdown deploy previews).
 * A workspace can opt specific bots back in by login via ALLOWED_BOTS (e.g. a
 * review bot like Pullfrog); see {@link shouldSkipActor}.
 */
export function isBotActor(user: { type?: string } | undefined | null): boolean {
  return user?.type === "Bot";
}

/** Normalize a bot login for matching: lowercase and drop GitHub's `[bot]` suffix. */
export function normalizeBotName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, "");
}

/**
 * Whether to skip mirroring an actor's comment/review. Humans are never skipped.
 * A bot is skipped unless its (normalized) login is in `allowedBots`, letting a
 * workspace surface a chosen review bot while still filtering deploy-preview noise.
 */
export function shouldSkipActor(
  user: { type?: string; login?: string } | undefined | null,
  allowedBots: ReadonlySet<string> = new Set(),
): boolean {
  if (!isBotActor(user)) return false;
  const login = user?.login ? normalizeBotName(user.login) : "";
  return !(login && allowedBots.has(login));
}
