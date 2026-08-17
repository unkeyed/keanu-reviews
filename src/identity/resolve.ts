import type { Db } from "../db/client.ts";
import { findByGithubId, upsertIdentity } from "../db/repositories/identities.ts";
import { sanitizeMrkdwn } from "../slack/blocks.ts";
import type { SlackClient } from "../slack/client.ts";

/** Fetch a GitHub user's public email (read-only; does not cross the one-way boundary). */
export type GithubEmailFetcher = (login: string) => Promise<string | undefined>;

export interface IdentityDeps {
  db: Db;
  slack: SlackClient;
  fetchGithubEmail?: GithubEmailFetcher;
}

/**
 * Resolve a GitHub reviewer to a Slack user id (KTD6, R11). Primary source is the
 * identity map (seeded by U9). Fallback: read the reviewer's public email and try
 * `users.lookupByEmail`, caching a hit back into the map. A private/noreply email
 * or an unknown Slack user yields undefined — the caller degrades to a plain login.
 */
export async function resolveSlackUser(
  deps: IdentityDeps,
  reviewer: { githubId: number; login: string },
): Promise<string | undefined> {
  const mapped = await findByGithubId(deps.db, reviewer.githubId);
  if (mapped) return mapped.slackUserId;

  if (!deps.fetchGithubEmail) return undefined;
  const email = await deps.fetchGithubEmail(reviewer.login);
  if (!email) return undefined;

  const slackUserId = await deps.slack.lookupUserByEmail(email);
  if (!slackUserId) return undefined;

  // Cache the match so we never pay the lookup twice.
  await upsertIdentity(deps.db, {
    githubUserId: reviewer.githubId,
    githubLogin: reviewer.login,
    slackUserId,
    source: "email-match",
  });
  return slackUserId;
}

/**
 * A non-pinging, Slack-safe label for a reviewer/commenter: their Slack display
 * name when linked, else their GitHub login. We deliberately never emit an
 * `<@id>` mention for reviewers — pinging someone for their own review activity
 * (or for a review request they're already invited to the channel for) is noise.
 */
export async function reviewerDisplayLabel(
  slack: SlackClient,
  slackUserId: string | undefined,
  login: string,
): Promise<string> {
  const name = slackUserId ? await slack.lookupUserName(slackUserId) : undefined;
  return sanitizeMrkdwn(name ?? login);
}
