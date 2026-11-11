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

export async function displayName(
  deps: ProfileDeps,
  slackUserId: string | undefined,
  login: string,
): Promise<string> {
  const name = slackUserId ? (await profileOrNone(deps, slackUserId))?.name : undefined;
  return name ?? login;
}
