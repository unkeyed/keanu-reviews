import type { Hono } from "hono";
import type { HandlerDeps } from "#app";
import type { Config } from "#config";
import type { Db } from "#db";
import {
  type InstallationAuth,
  createCiReadinessFetcher,
  createGithubAttachmentMirror,
  createGithubEmailFetcher,
  createPrCommenter,
  createPrForShaFetcher,
  createPullRequestFetcher,
  createReviewApprovalFetcher,
} from "#github";
import {
  createSlackOAuthRoute,
  deleteSlackUserToken,
  getSlackUserTokenRow,
  getSlackUserTokenRows,
} from "#identity";
import { type Logger, createTokenCipher, errMessage, systemClock } from "#lib";
import {
  SLACK_POST_USER_SCOPE,
  type SlackGateway,
  createSlackOAuthClient,
  hasScope,
  quietlyRemoveMembers,
} from "#slack";

export interface ServiceHandlers {
  /** Dependencies shared by the webhook worker, the reminder scan and closed-PR reconciliation. */
  handler: HandlerDeps;
  slackOauthRoute?: Hono;
  attachmentRoute: Hono;
}

/**
 * Build the pull-request handler dependencies once so the webhook worker and the
 * reconciliation command archive channels the same way.
 */
export function createServiceHandlers(input: {
  config: Config;
  db: Db;
  slack: SlackGateway;
  logger: Logger;
  auth: InstallationAuth;
}): ServiceHandlers {
  const { config, db, slack, logger, auth } = input;
  const installationId = config.GITHUB_INSTALLATION_ID;
  const slackOauthCallbackUrl = `${config.PUBLIC_URL}/oauth/slack/callback`;

  let quietArchive: HandlerDeps["quietArchive"];
  let authorPoster: HandlerDeps["authorPoster"];
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
    // A token that no longer decrypts falls back to the bot but is kept: a
    // misconfigured key at deploy would otherwise wipe every stored token.
    const decrypt = (slackUserId: string, encryptedToken: string) => {
      try {
        return cipher.decrypt(encryptedToken);
      } catch (error) {
        logger.warn("Slack user token cannot be decrypted; posting as the bot", {
          slackUserId,
          err: errMessage(error),
        });
        return undefined;
      }
    };
    const readUserToken = async (slackUserId: string, requiredScope: string) => {
      const row = await getSlackUserTokenRow(db, config.SLACK_TEAM_ID, slackUserId);
      if (!row || !hasScope(row.scopes, requiredScope)) return undefined;
      return decrypt(slackUserId, row.encryptedToken);
    };
    quietArchive = async (channelId) => {
      await quietlyRemoveMembers(
        {
          slack,
          logger,
          getUserTokens: async (slackUserIds) => {
            const rows = await getSlackUserTokenRows(db, config.SLACK_TEAM_ID, slackUserIds);
            const tokens = new Map<string, string>();
            for (const slackUserId of slackUserIds) {
              const row = rows.get(slackUserId);
              const token = row && decrypt(slackUserId, row.encryptedToken);
              if (token) tokens.set(slackUserId, token);
            }
            return tokens;
          },
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

  const attachments = createGithubAttachmentMirror({
    publicUrl: config.PUBLIC_URL,
    secret: config.OAUTH_STATE_SECRET,
  });
  const handler: HandlerDeps = {
    db,
    slack,
    logger,
    clock: systemClock,
    fetchGithubEmail: createGithubEmailFetcher(auth, installationId),
    fetchCiReadiness: createCiReadinessFetcher(auth, installationId),
    fetchPullRequest: createPullRequestFetcher(auth, installationId),
    fetchApprovalCount: createReviewApprovalFetcher(auth, installationId),
    fetchPrForSha: createPrForShaFetcher(auth, installationId),
    reminderHours: config.REMINDER_HOURS,
    reminderWindow: {
      startHour: config.REMINDER_WINDOW_START_HOUR,
      endHour: config.REMINDER_WINDOW_END_HOUR,
      timeZone: config.REMINDER_WINDOW_TZ,
    },
    // Don't remind once the PR is ready to merge or has this many approvals.
    suppressApprovals: config.REMINDER_SUPPRESS_APPROVALS,
    shippedChannel: config.SLACK_SHIPPED_CHANNEL,
    commentOnMerge: config.GITHUB_COMMENT_ON_MERGE,
    postPrComment: config.GITHUB_COMMENT_ON_MERGE
      ? createPrCommenter(auth, installationId)
      : undefined,
    slackTeamId: config.SLACK_TEAM_ID,
    embedImages: attachments.embedImages,
    quietArchive,
    authorPoster,
    allowedBots: config.ALLOWED_BOTS,
    threadComments: config.THREAD_COMMENTS,
  };

  return {
    handler,
    slackOauthRoute,
    attachmentRoute: attachments.route,
  };
}
