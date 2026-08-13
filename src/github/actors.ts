/**
 * GitHub marks automation accounts (Vercel, Mintlify, Dependabot, our own App's
 * bot, …) with `type: "Bot"` on the user object. We skip mirroring their
 * comments/reviews — they're noisy (often raw markdown deploy previews) and not
 * the human conversation the channel is for.
 */
export function isBotActor(user: { type?: string } | undefined | null): boolean {
  return user?.type === "Bot";
}
