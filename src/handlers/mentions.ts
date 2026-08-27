import { findByGithubLogin } from "../db/repositories/identities.ts";
import type { PrHandlerDeps } from "./pullRequest.ts";

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
 * bots) are silently ignored. Never throws — a lookup or invite failure must not
 * block comment mirroring. inviteUsers is idempotent, so repeated mentions of an
 * existing member are a no-op.
 *
 * `excludeLogin` (the PR author) is skipped — they're invited to their own
 * channel by default, so there's no need to re-invite them for a mention.
 */
export async function inviteMentionedUsers(
  deps: PrHandlerDeps,
  channelId: string,
  body: string,
  excludeLogin?: string,
): Promise<void> {
  const skip = excludeLogin?.toLowerCase();
  const logins = extractGithubMentions(body).filter((login) => login !== skip);
  if (logins.length === 0) return;
  try {
    const ids = new Set<string>();
    for (const login of logins) {
      const identity = await findByGithubLogin(deps.db, login);
      if (identity) ids.add(identity.slackUserId);
    }
    if (ids.size > 0) await deps.slack.inviteUsers(channelId, [...ids]);
  } catch (error) {
    deps.logger.warn("failed to invite mentioned users into channel", {
      channelId,
      err: error instanceof Error ? error.message : String(error),
    });
  }
}
