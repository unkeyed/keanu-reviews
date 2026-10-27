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
    quietArchive = async (channelId) => {
      await quietlyRemoveMembers(
        {
          slack,
          logger,
          getUserToken: async (slackUserId) => {
            const row = await getSlackUserTokenRow(db, config.SLACK_TEAM_ID, slackUserId);
            return row ? cipher.decrypt(row.encryptedToken) : undefined;
          },
          onInvalidToken: dropToken,
        },
        channelId,
      );
    };
    authorPoster = {
      getUserToken: async (slackUserId) => {
        const row = await getSlackUserTokenRow(db, config.SLACK_TEAM_ID, slackUserId);
        if (!row || !hasScope(row.scopes, SLACK_POST_USER_SCOPE)) return undefined;
        return cipher.decrypt(row.encryptedToken);
      },
      onInvalidToken: dropToken,
    };
    logger.info("quiet archiving + post-as-user enabled (Slack user OAuth configured)");
  }

  const fetchPullRequest = createPullRequestFetcher(auth, installationId);
  const fetchCiReadiness = createCiReadinessFetcher(auth, installationId, { logger });
  const handler: PrHandlerDeps = {
    db,
    slack,
    logger,
    fetchGithubEmail: createGithubEmailFetcher(auth, installationId),
    fetchCiReadiness,
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
