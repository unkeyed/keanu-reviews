import { findSlackUsersByGithubLogins } from "#identity";
import { errMessage } from "#lib";
import type { PrChannel } from "./channel.ts";
import type { PrDeps } from "./converge.ts";

// GitHub logins are 1–39 chars: alphanumerics with single internal hyphens, no
// leading/trailing hyphen. The lookbehind skips email locals (`foo@bar`); the
// trailing lookahead forces a maximal token and skips team mentions (`@org/team`)
// — without `[-a-z\d/]` the engine would backtrack `@unkey/api` to `unke`.
const MENTION_RE = /(?<![\w@/])@([a-z\d](?:-?[a-z\d]){0,38})(?![-a-z\d/])/gi;

/** Unique, lowercased GitHub logins @-mentioned in a comment/review body. */
export function extractGithubMentions(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) {
    const login = match[1]?.toLowerCase();
    if (login) found.add(login);
  }
  return [...found];
}

/**
 * Best-effort: pull the Slack users linked to any @-mentioned GitHub logins into
 * the PR channel, so "hey @dave-hawkins" adds dave to the conversation. Only
 * already-linked users can be resolved; unknown logins (unlinked users, teams,
 * bots) are silently ignored. Never throws: a lookup or invite failure must not
 * block comment mirroring.
 */
export async function inviteMentions(
  deps: PrDeps,
  channel: PrChannel,
  body: string,
  excludeLogin: string | undefined,
): Promise<void> {
  const skip = excludeLogin?.toLowerCase();
  const logins = extractGithubMentions(body).filter((login) => login !== skip);
  if (logins.length === 0) return;
  try {
    const linked = await findSlackUsersByGithubLogins(deps.db, logins);
    const ids = new Set(logins.flatMap((login) => linked.get(login) ?? []));
    if (ids.size > 0) await channel.invite([...ids], { role: "mention" });
  } catch (error) {
    deps.logger.warn("failed to invite mentioned users into channel", {
      channelId: channel.channel,
      err: errMessage(error),
    });
  }
}
