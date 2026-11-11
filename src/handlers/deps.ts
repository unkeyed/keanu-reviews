import type { Hono } from "hono";
import type { Config } from "#config";
import type { Db } from "#db";
import {
  type CiReadinessFetcher,
  type ImageEmbedder,
  type InstallationAuth,
  type PrForShaFetcher,
  type PullRequestFetcher,
  type ReviewApprovalFetcher,
  createCiReadinessFetcher,
  createGithubAttachmentMirror,
  createGithubEmailFetcher,
  createPrCommenter,
  createPrForShaFetcher,
  createPullRequestFetcher,
  createReviewApprovalFetcher,
} from "#github";
import { createSlackOAuthRoute, deleteSlackUserToken, getSlackUserTokenRow } from "#identity";
import { type Logger, createTokenCipher, errMessage } from "#lib";
import type { PrDeps } from "#pr";
import {
  SLACK_POST_USER_SCOPE,
  type SlackGateway,
  createSlackOAuthClient,
  hasScope,
  quietlyRemoveMembers,
} from "#slack";

export interface PrHandlerDeps extends PrDeps {
  /**
   * Aggregate CI for the PR head. Review-needed alerts wait until this is
   * passing. Omit to keep the previous behavior (drafts still wait; CI is not
   * consulted).
   */
  fetchCiReadiness?: CiReadinessFetcher;
  /** Optional PR read: mergeability for reminders, and requested reviewers for alerts. */
  fetchPullRequest?: PullRequestFetcher;
  embedImages?: ImageEmbedder;
  /** Bot logins (normalized) whose comments/reviews should be mirrored anyway. */
  allowedBots?: ReadonlySet<string>;
  /**
   * When true (default), a reply within a GitHub review thread is posted as a
   * Slack threaded reply under the original comment's message. When false, every
   * comment posts top-level (flat). Thread-starting comments and PR conversation
   * comments are always top-level regardless.
   */
  threadComments?: boolean;
  /**
   * Optional post-as-user capability. When wired (Slack user-OAuth configured),
   * mirrored comments/reviews are authored with the linked user's own token
   * instead of the bot. `getUserToken` returns a decrypted token ONLY when the
   * user granted `chat:write`; `onInvalidToken` drops a token Slack reports dead.
   */
  authorPoster?: {
    getUserToken: (slackUserId: string) => Promise<string | undefined>;
    onInvalidToken: (slackUserId: string) => Promise<void>;
  };
}

export interface ServiceHandlers {
  /** Dependencies shared by the webhook worker and closed-PR reconciliation. */
  handler: PrHandlerDeps;
  fetchPullRequest: PullRequestFetcher;
  fetchApprovalCount: ReviewApprovalFetcher;
  fetchCiReadiness: CiReadinessFetcher;
  fetchPrForSha: PrForShaFetcher;
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
    // A token that no longer decrypts falls back to the bot but is kept: a
    // misconfigured key at deploy would otherwise wipe every stored token.
    const readUserToken = async (slackUserId: string, requiredScope?: string) => {
      const row = await getSlackUserTokenRow(db, config.SLACK_TEAM_ID, slackUserId);
      if (!row || (requiredScope && !hasScope(row.scopes, requiredScope))) return undefined;
      try {
        return cipher.decrypt(row.encryptedToken);
      } catch (error) {
        logger.warn("Slack user token cannot be decrypted; posting as the bot", {
          slackUserId,
          err: errMessage(error),
        });
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

  const attachments = createGithubAttachmentMirror({
    publicUrl: config.PUBLIC_URL,
    secret: config.OAUTH_STATE_SECRET,
  });
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
    embedImages: attachments.embedImages,
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
    attachmentRoute: attachments.route,
  };
}
