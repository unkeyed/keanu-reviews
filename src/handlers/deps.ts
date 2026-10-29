import type { Hono } from "hono";
import type { PrForShaFetcher } from "../ci/status.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { deleteSlackUserToken, getSlackUserTokenRow } from "../db/repositories/slackUserTokens.ts";
import type { InstallationAuth } from "../github/auth.ts";
import { createPrCommenter } from "../github/comments.ts";
import {
  createCiReadinessFetcher,
  createGithubEmailFetcher,
  createPrForShaFetcher,
  createPullRequestFetcher,
  createReviewApprovalFetcher,
} from "../github/users.ts";
import type { CiReadinessFetcher, ReviewApprovalFetcher } from "../github/users.ts";
import type { Logger } from "../logger.ts";
import { createSlackOAuthRoute } from "../routes/slackOAuth.ts";
import type { SlackClient } from "../slack/client.ts";
import { quietlyRemoveMembers } from "../slack/memberCleanup.ts";
import { SLACK_POST_USER_SCOPE, createSlackOAuthClient, hasScope } from "../slack/oauth.ts";
import { createTokenCipher } from "../slack/tokenCipher.ts";
import type { PullRequestFetcher } from "./mergeability.ts";
import type { PrHandlerDeps } from "./pullRequest.ts";

export interface ServiceHandlers {
  /** Dependencies shared by the webhook worker and closed-PR reconciliation. */
  handler: PrHandlerDeps;
  fetchPullRequest: PullRequestFetcher;
  fetchApprovalCount: ReviewApprovalFetcher;
  fetchCiReadiness: CiReadinessFetcher;
  fetchPrForSha: PrForShaFetcher;
  slackOauthRoute?: Hono;
}

/**
 * Build the pull-request handler dependencies once so the webhook worker and the
 * reconciliation command archive channels the same way.
 */
export function createServiceHandlers(input: {
  config: Config;
  db: Db;
  slack: SlackClient;
  logger: Logger;
  auth: InstallationAuth;
}): ServiceHandlers {
  const { config, db, slack, logger, auth } = input;
  const installationId = config.GITHUB_INSTALLATION_ID;
  const slackOauthCallbackUrl = `${config.PUBLIC_URL}/oauth/slack/callback`;

  let quietArchive: PrHandlerDeps["quietArchive"];
  let authorPoster: PrHandlerDeps["authorPoster"];
  let slackOauthRoute: Hono | undefined;

  // Quiet archiving (opt-in): when Slack user-OAuth is configured, collect
  // per-user tokens so PR channels can be emptied of members before archive,
  // suppressing Slack's "archived the channel" notification. Config enforces
  // that the three settings are present together, so testing one is sufficient.
  if (
    config.SLACK_OAUTH_CLIENT_ID &&
    config.SLACK_OAUTH_CLIENT_SECRET &&
    config.SLACK_USER_TOKEN_ENC_KEY
  ) {
    const cipher = createTokenCipher(config.SLACK_USER_TOKEN_ENC_KEY);
    slackOauthRoute = createSlackOAuthRoute({
      db,
      logger,
      oauthClient: createSlackOAuthClient({
        clientId: config.SLACK_OAUTH_CLIENT_ID,
        clientSecret: config.SLACK_OAUTH_CLIENT_SECRET,
      }),
      oauthStateSecret: config.OAUTH_STATE_SECRET,
      slackTeamId: config.SLACK_TEAM_ID,
      callbackUrl: slackOauthCallbackUrl,
      cipher,
    });
    const dropToken = (slackUserId: string) =>
      deleteSlackUserToken(db, config.SLACK_TEAM_ID, slackUserId);
    // A token that no longer decrypts (rotated key, corrupt row) can never be
    // used again, so it is dropped like a token Slack reports dead.
    const readUserToken = async (slackUserId: string, requiredScope?: string) => {
      const row = await getSlackUserTokenRow(db, config.SLACK_TEAM_ID, slackUserId);
      if (!row || (requiredScope && !hasScope(row.scopes, requiredScope))) return undefined;
      try {
        return cipher.decrypt(row.encryptedToken);
      } catch (error) {
        logger.warn("dropping a Slack user token that cannot be decrypted", {
          slackUserId,
          err: error instanceof Error ? error.message : String(error),
        });
        await dropToken(slackUserId);
        return undefined;
      }
    };
    quietArchive = async (channelId) => {
      await quietlyRemoveMembers(
        {
          slack,
          logger,
          getUserToken: (slackUserId) => readUserToken(slackUserId),
          onInvalidToken: dropToken,
        },
        channelId,
      );
    };
    authorPoster = {
      getUserToken: (slackUserId) => readUserToken(slackUserId, SLACK_POST_USER_SCOPE),
      onInvalidToken: dropToken,
    };
    logger.info("quiet archiving + post-as-user enabled (Slack user OAuth configured)");
  }

  const fetchPullRequest = createPullRequestFetcher(auth, installationId);
  const fetchCiReadiness = createCiReadinessFetcher(auth, installationId);
  const handler: PrHandlerDeps = {
    db,
    slack,
    logger,
    fetchGithubEmail: createGithubEmailFetcher(auth, installationId),
    fetchCiReadiness,
    fetchPullRequest,
    shippedChannel: config.SLACK_SHIPPED_CHANNEL,
    commentOnMerge: config.GITHUB_COMMENT_ON_MERGE,
    postPrComment: config.GITHUB_COMMENT_ON_MERGE
      ? createPrCommenter(auth, installationId)
      : undefined,
    slackTeamId: config.SLACK_TEAM_ID,
    quietArchive,
    authorPoster,
    allowedBots: config.ALLOWED_BOTS,
    threadComments: config.THREAD_COMMENTS,
  };

  return {
    handler,
    fetchPullRequest,
    fetchApprovalCount: createReviewApprovalFetcher(auth, installationId),
    fetchCiReadiness,
    fetchPrForSha: createPrForShaFetcher(auth, installationId),
    slackOauthRoute,
  };
}
