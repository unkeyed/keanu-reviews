import type { Hono } from "hono";
import { type Config, SECRET_KEYS } from "#config";
import { type Db, createDb } from "#db";
import {
  type GithubUserFetcher,
  type PullRequestSnapshotFetcher,
  createCiReadinessFetcher,
  createGithubAttachmentMirror,
  createGithubEmailFetcher,
  createGithubOAuthClient,
  createGithubUserFetcher,
  createInstallationAuth,
  createPrCommenter,
  createPrForShaFetcher,
  createPullRequestFetcher,
  createPullRequestSnapshotFetcher,
  createReviewApprovalFetcher,
  octokitMintFn,
} from "#github";
import {
  createGithubOAuthRoute,
  createSlackCommandRoute,
  createSlackOAuthRoute,
  deleteSlackUserToken,
  getSlackUserTokenRow,
  getSlackUserTokenRows,
} from "#identity";
import {
  type Logger,
  type TokenCipher,
  createLogger,
  createTokenCipher,
  errMessage,
  registerSecrets,
  systemClock,
} from "#lib";
import {
  SLACK_POST_USER_SCOPE,
  createSlackGateway,
  createSlackOAuthClient,
  hasScope,
  quietlyRemoveMembers,
} from "#slack";
import type { HandlerDeps } from "./handlers.ts";

/** Everything the service, and each admin command, runs against. */
export interface AppContext {
  config: Config;
  logger: Logger;
  db: Db;
  /** What every webhook handler, the reminder scan and the daily reconcile read. */
  deps: HandlerDeps;
  /** GitHub's view of one PR, for the daily reconcile; the same reader as `deps.fetchSnapshot`. */
  fetchSnapshot: PullRequestSnapshotFetcher;
  /** GitHub user by login, for the identity import. */
  fetchGithubUser: GithubUserFetcher;
  /** Routes beside health and the webhook: attachments, OAuth and the Slack command. */
  routes: readonly Hono[];
  close(): Promise<void>;
}

/** Build every client once, from config. The only place concrete clients are made. */
export function createContext(config: Config): AppContext {
  registerSecrets({ keys: SECRET_KEYS, values: SECRET_KEYS.map((k) => config[k]) });
  const logger = createLogger(config.LOG_LEVEL, { service: "keanu-reviews" });
  const slack = createSlackGateway(config.SLACK_BOT_TOKEN, {
    onImageFallback: (info) =>
      logger.warn("slack refused embedded images; retrying with links", info),
  });
  const auth = createInstallationAuth(
    octokitMintFn(config.GITHUB_APP_ID, config.GITHUB_APP_PRIVATE_KEY),
  );
  const installationId = config.GITHUB_INSTALLATION_ID;
  const teamId = config.SLACK_TEAM_ID;
  // Config enforces that the three Slack user-OAuth settings come together.
  const slackOAuth =
    config.SLACK_OAUTH_CLIENT_ID &&
    config.SLACK_OAUTH_CLIENT_SECRET &&
    config.SLACK_USER_TOKEN_ENC_KEY
      ? {
          clientId: config.SLACK_OAUTH_CLIENT_ID,
          clientSecret: config.SLACK_OAUTH_CLIENT_SECRET,
          cipher: createTokenCipher(config.SLACK_USER_TOKEN_ENC_KEY),
        }
      : undefined;
  const attachments = createGithubAttachmentMirror({
    publicUrl: config.PUBLIC_URL,
    secret: config.OAUTH_STATE_SECRET,
  });
  // Open the pool last so a failure while building clients cannot strand it.
  const { db, close } = createDb(config.DATABASE_URL);
  const userTokens =
    slackOAuth && userTokenAccess({ db, slack, logger, teamId, cipher: slackOAuth.cipher });

  const fetchSnapshot = createPullRequestSnapshotFetcher(auth, installationId, { logger });
  const deps: HandlerDeps = {
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
    slackTeamId: teamId,
    embedImages: attachments.embedImages,
    quietArchive: userTokens?.quietArchive,
    authorPoster: userTokens?.authorPoster,
    allowedBots: config.ALLOWED_BOTS,
    threadComments: config.THREAD_COMMENTS,
    fetchSnapshot,
  };

  const githubOauthCallbackUrl = `${config.PUBLIC_URL}/oauth/github/callback`;
  const slackOauthCallbackUrl = `${config.PUBLIC_URL}/oauth/slack/callback`;
  const routes: Hono[] = [
    attachments.route,
    createGithubOAuthRoute({
      db,
      logger,
      oauthClient: createGithubOAuthClient({
        clientId: config.GITHUB_OAUTH_CLIENT_ID,
        clientSecret: config.GITHUB_OAUTH_CLIENT_SECRET,
      }),
      oauthStateSecret: config.OAUTH_STATE_SECRET,
      slackTeamId: teamId,
      callbackUrl: githubOauthCallbackUrl,
    }),
    createSlackCommandRoute({
      db,
      logger,
      signingSecret: config.SLACK_SIGNING_SECRET,
      slackTeamId: teamId,
      oauthStateSecret: config.OAUTH_STATE_SECRET,
      githubOauthClientId: config.GITHUB_OAUTH_CLIENT_ID,
      githubOauthCallbackUrl,
      slackOauthClientId: config.SLACK_OAUTH_CLIENT_ID,
      slackOauthCallbackUrl: slackOAuth ? slackOauthCallbackUrl : undefined,
    }),
  ];
  if (slackOAuth) {
    routes.push(
      createSlackOAuthRoute({
        db,
        logger,
        oauthClient: createSlackOAuthClient({
          clientId: slackOAuth.clientId,
          clientSecret: slackOAuth.clientSecret,
        }),
        oauthStateSecret: config.OAUTH_STATE_SECRET,
        slackTeamId: teamId,
        callbackUrl: slackOauthCallbackUrl,
        cipher: slackOAuth.cipher,
      }),
    );
  }

  return {
    config,
    logger,
    db,
    deps,
    fetchSnapshot,
    fetchGithubUser: createGithubUserFetcher(auth, installationId),
    routes,
    close,
  };
}

/**
 * Post-as-user and quiet archiving, from the tokens members granted through
 * Slack user OAuth. A token that no longer decrypts falls back to the bot but
 * is kept: a misconfigured key at deploy would otherwise wipe every stored token.
 */
export function userTokenAccess(input: {
  db: Db;
  slack: HandlerDeps["slack"];
  logger: Logger;
  teamId: string;
  cipher: TokenCipher;
}): Pick<HandlerDeps, "quietArchive" | "authorPoster"> {
  const { db, slack, logger, teamId, cipher } = input;
  const dropToken = (slackUserId: string) => deleteSlackUserToken(db, teamId, slackUserId);
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
  return {
    quietArchive: async (channelId) => {
      await quietlyRemoveMembers(
        {
          slack,
          logger,
          getUserTokens: async (slackUserIds) => {
            const rows = await getSlackUserTokenRows(db, teamId, slackUserIds);
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
    },
    authorPoster: {
      getUserToken: async (slackUserId) => {
        const row = await getSlackUserTokenRow(db, teamId, slackUserId);
        if (!row || !hasScope(row.scopes, SLACK_POST_USER_SCOPE)) return undefined;
        return decrypt(slackUserId, row.encryptedToken);
      },
      onInvalidToken: dropToken,
    },
  };
}
