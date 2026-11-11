import type { Db } from "#db";
import type { GithubEmailFetcher } from "#github";
import { type Logger, errMessage } from "#lib";
import type { SlackGateway, SlackProfile } from "#slack";
import { findByGithubId, upsertIdentity } from "./store.ts";

export interface IdentityDeps {
  db: Db;
  slack: SlackGateway;
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

  const slackUserId = await deps.slack.lookupByEmail(email);
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

export interface ProfileDeps {
  slack: Pick<SlackGateway, "profile">;
  logger: Logger;
}

/**
 * A linked user's Slack name and avatar, which only decorate a post. Fails
 * open: when `users.info` fails the post goes out under the GitHub login
 * rather than fail. Resolving who the user is stays strict, since a degraded
 * lookup would post "no linked user" for good.
 */
export async function profileOrNone(
  deps: ProfileDeps,
  slackUserId: string,
): Promise<SlackProfile | undefined> {
  try {
    return await deps.slack.profile(slackUserId);
  } catch (err) {
    deps.logger.warn("Slack profile read failed; labelling with the GitHub login", {
      slackUserId,
      err: errMessage(err),
    });
    return undefined;
  }
}

/**
 * A non-pinging label for a reviewer or commenter: their Slack display name
 * when linked, else their GitHub login. Never an `<@id>`: pinging someone for
 * their own review activity, or for a request that already invited them, is noise.
 */
export async function displayName(
  deps: ProfileDeps,
  slackUserId: string | undefined,
  login: string,
): Promise<string> {
  const name = slackUserId ? (await profileOrNone(deps, slackUserId))?.name : undefined;
  return name ?? login;
}
