import { ErrorCode, WebClient, type WebClientOptions } from "@slack/web-api";
import type { LeaveChannelOutcome, SlackClient, SlackMessage } from "./client.ts";
import { Pacer, type SleepFn, withRetry } from "./rateLimiter.ts";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_RETRIES = 1;
const MAX_RATE_LIMIT_DELAY_MS = 5_000;

export function isSlackChannelAlreadyInState(
  error: unknown,
  expectedCode: "already_archived" | "not_archived",
): boolean {
  return (error as { data?: { error?: string } })?.data?.error === expectedCode;
}

interface SlackUserLookupApi {
  lookupByEmail(input: { email: string }): Promise<{ user?: { id?: string } }>;
  info(input: { user: string }): Promise<{
    user?: {
      name?: string;
      real_name?: string;
      profile?: {
        display_name?: string;
        real_name?: string;
        image_72?: string;
        image_48?: string;
      };
    };
  }>;
}

/**
 * The reviewer's Slack display name (what Slack shows in the client): their
 * chosen display name if set, otherwise their real name. Returns undefined for
 * an unknown user so callers can fall back to the GitHub login. Requires the
 * `users:read` scope (already implied by `users:read.email`).
 */
export async function lookupSlackUserName(
  users: Pick<SlackUserLookupApi, "info">,
  userId: string,
): Promise<string | undefined> {
  try {
    const result = await users.info({ user: userId });
    const profile = result.user?.profile;
    const name =
      profile?.display_name?.trim() ||
      profile?.real_name?.trim() ||
      result.user?.real_name?.trim() ||
      result.user?.name?.trim();
    return name || undefined;
  } catch (error) {
    if (slackErrorCode(error) === "user_not_found") return undefined;
    throw error;
  }
}

function slackErrorCode(error: unknown): string | undefined {
  return (error as { data?: { error?: string } })?.data?.error;
}

/**
 * The user's display name + avatar for authoring a mirrored comment as them.
 * Returns undefined for an unknown user so callers fall back to bot authorship.
 */
export async function lookupSlackUserProfile(
  users: Pick<SlackUserLookupApi, "info">,
  userId: string,
): Promise<{ name?: string; iconUrl?: string } | undefined> {
  try {
    const result = await users.info({ user: userId });
    const profile = result.user?.profile;
    const name =
      profile?.display_name?.trim() ||
      profile?.real_name?.trim() ||
      result.user?.real_name?.trim() ||
      result.user?.name?.trim() ||
      undefined;
    const iconUrl = profile?.image_72?.trim() || profile?.image_48?.trim() || undefined;
    if (!name && !iconUrl) return undefined;
    return { name, iconUrl };
  } catch (error) {
    if (slackErrorCode(error) === "user_not_found") return undefined;
    throw error;
  }
}

interface SlackWebApi {
  conversations: {
    create(input: { name: string }): Promise<{ channel?: { id?: string } }>;
    join(input: { channel: string }): Promise<unknown>;
    rename(input: { channel: string; name: string }): Promise<unknown>;
    setTopic(input: { channel: string; topic: string }): Promise<unknown>;
    archive(input: { channel: string }): Promise<unknown>;
    unarchive(input: { channel: string }): Promise<unknown>;
    invite(input: { channel: string; users: string }): Promise<unknown>;
    members(input: { channel: string; cursor?: string; limit: number }): Promise<unknown>;
    leave(input: { channel: string }): Promise<unknown>;
    list(input: {
      cursor?: string;
      exclude_archived: boolean;
      limit: number;
      types: string;
    }): Promise<unknown>;
  };
  users: SlackUserLookupApi;
  apiCall(method: string, options?: Record<string, unknown>): Promise<unknown>;
}

/** Slack error codes that mean a stored user token can never succeed again. */
const DEAD_TOKEN_ERRORS = new Set([
  "token_revoked",
  "invalid_auth",
  "account_inactive",
  "not_authed",
  "token_expired",
]);

export interface WebApiSlackClientOptions {
  /** Injected by offline adapter tests; production creates the official WebClient. */
  web?: SlackWebApi;
  webFactory?: (token: string, options: WebClientOptions) => SlackWebApi;
  /** Builds a Slack client bound to a *user* token (for silent leave). */
  userWebFactory?: (token: string) => SlackWebApi;
  sleep?: SleepFn;
  now?: () => number;
}

function requireNonEmptyString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Slack ${description} response did not include a value`);
  }
  return value;
}

/** Slack uses `users_not_found` for a legitimate lookup miss; all other errors are operational. */
export async function lookupSlackUserByEmail(
  users: Pick<SlackUserLookupApi, "lookupByEmail">,
  email: string,
): Promise<string | undefined> {
  try {
    const result = await users.lookupByEmail({ email });
    return requireNonEmptyString(result.user?.id, "users.lookupByEmail user ID");
  } catch (error) {
    if ((error as { data?: { error?: string } })?.data?.error === "users_not_found") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Real Slack client (KTD9). Wraps @slack/web-api, retries on 429 honoring
 * Retry-After, and paces posts to ~1/sec per channel. Channel creation is
 * serialized under one key so a PR flood queues within the Tier-2 limit.
 */
export function createWebApiSlackClient(
  token: string,
  options: WebApiSlackClientOptions = {},
): SlackClient {
  const webFactory = options.webFactory ?? ((apiToken, config) => new WebClient(apiToken, config));
  const web: SlackWebApi =
    options.web ??
    webFactory(token, {
      // Durable jobs own retries. SDK defaults can otherwise retry for roughly
      // 30 minutes, far beyond the worker and message-effect leases.
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: REQUEST_TIMEOUT_MS,
    });
  const userWebFactory =
    options.userWebFactory ??
    ((userToken: string) =>
      webFactory(userToken, {
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        timeout: REQUEST_TIMEOUT_MS,
      }));
  const postPacer = new Pacer(1000, options.sleep, options.now);
  const createPacer = new Pacer(3000, options.sleep, options.now); // ~20/min Tier-2 headroom

  const normalizeSlackError = (e: unknown): unknown => {
    const err = e as {
      code?: string;
      retryAfter?: number;
      data?: { error?: string; needed?: string; provided?: string };
    };
    if (err?.code === ErrorCode.RateLimitedError) {
      return { status: 429, retryAfterSeconds: err.retryAfter ?? 1 };
    }
    // Slack platform errors carry actionable detail (which scope is missing,
    // which channel, etc.) on `data`. The default `.message` drops it, so lift
    // `needed`/`provided` into the message the worker logs.
    const slackCode = err?.data?.error;
    if (slackCode) {
      const parts = [`Slack API error: ${slackCode}`];
      if (err.data?.needed) parts.push(`needed scope: ${err.data.needed}`);
      if (err.data?.provided) parts.push(`provided scopes: ${err.data.provided}`);
      const enriched = new Error(parts.join(" — "), { cause: e });
      Object.assign(enriched, {
        slackError: slackCode,
        neededScope: err.data?.needed,
        providedScopes: err.data?.provided,
      });
      return enriched;
    }
    return e;
  };
  const call = <T>(fn: () => Promise<T>): Promise<T> =>
    withRetry(
      () =>
        fn().catch((e) => {
          throw normalizeSlackError(e);
        }),
      {
        maxRetries: MAX_RATE_LIMIT_RETRIES,
        maxRetryDelayMs: MAX_RATE_LIMIT_DELAY_MS,
        sleep: options.sleep,
      },
    );

  // Make a channel writable before an op that must succeed. Two recoverable
  // states, each fixed once then retried:
  //   • `not_in_channel` — the bot was removed or recovered a channel by name;
  //     rejoin it (needs `channels:join`).
  //   • `is_archived` — the channel was archived (a prior terminal event, an
  //     out-of-order merge, or a manual archive). Any write/rename to it fails,
  //     which otherwise poisons every future job for that PR. Unarchive and retry
  //     (needs `channels:manage`); the reconciler re-archives later if terminal.
  // Bounded to two recoveries so a channel that is both archived AND left can be
  // healed in one call without risking an infinite loop.
  const withWritableChannel = async <T>(channel: string, op: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await op();
      } catch (error) {
        const code = slackErrorCode(error);
        if (attempt < 2 && code === "not_in_channel") {
          await web.conversations.join({ channel });
          continue;
        }
        if (attempt < 2 && code === "is_archived") {
          await web.conversations.unarchive({ channel });
          continue;
        }
        throw error;
      }
    }
  };

  return {
    createChannel: (name) =>
      createPacer.run("create", () =>
        call(async () => {
          const res = await web.conversations.create({ name });
          return {
            channelId: requireNonEmptyString(res.channel?.id, "conversations.create channel ID"),
          };
        }),
      ),
    findChannelByName: async (name) => {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        const result = (await call(() =>
          web.conversations.list({
            cursor,
            exclude_archived: false,
            limit: 200,
            // This service creates public channels, so recovery needs only the
            // channels:read scope and never enumerates private conversations.
            types: "public_channel",
          }),
        )) as {
          channels?: unknown;
          response_metadata?: { next_cursor?: unknown };
        };
        if (!Array.isArray(result.channels)) {
          throw new Error("Slack conversations.list response did not include a channels array");
        }
        for (const channel of result.channels) {
          const candidate = channel as { id?: unknown; name?: unknown };
          if (candidate.name === name) {
            return requireNonEmptyString(candidate.id, "conversations.list channel ID");
          }
        }
        const nextCursor = result.response_metadata?.next_cursor;
        if (nextCursor !== undefined && typeof nextCursor !== "string") {
          throw new Error("Slack conversations.list response included an invalid cursor");
        }
        cursor = nextCursor?.trim() || undefined;
        if (cursor && seenCursors.has(cursor)) {
          throw new Error("Slack conversations.list returned a repeated cursor");
        }
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      return undefined;
    },
    renameChannel: (channelId, name) =>
      call(() =>
        withWritableChannel(channelId, async () => {
          await web.conversations.rename({ channel: channelId, name });
        }),
      ),
    setTopic: (channelId, topic) =>
      call(() =>
        withWritableChannel(channelId, async () => {
          await web.conversations.setTopic({ channel: channelId, topic });
        }),
      ),
    archiveChannel: (channelId) =>
      call(async () => {
        try {
          await withWritableChannel(channelId, () =>
            web.conversations.archive({ channel: channelId }),
          );
        } catch (error) {
          if (!isSlackChannelAlreadyInState(error, "already_archived")) throw error;
        }
      }),
    unarchiveChannel: (channelId) =>
      call(async () => {
        try {
          await withWritableChannel(channelId, () =>
            web.conversations.unarchive({ channel: channelId }),
          );
        } catch (error) {
          if (!isSlackChannelAlreadyInState(error, "not_archived")) throw error;
        }
      }),
    inviteUsers: (channelId, userIds) =>
      call(async () => {
        if (userIds.length > 0) {
          try {
            await withWritableChannel(channelId, () =>
              web.conversations.invite({ channel: channelId, users: userIds.join(",") }),
            );
          } catch (error) {
            // An ambiguous earlier invite may have succeeded. Treat Slack's
            // already-present response as the idempotent success it represents.
            if (slackErrorCode(error) !== "already_in_channel") throw error;
          }
        }
      }),
    listChannelMembers: async (channelId) => {
      const members: string[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        const result = (await call(() =>
          withWritableChannel(channelId, () =>
            web.conversations.members({ channel: channelId, cursor, limit: 200 }),
          ),
        )) as { members?: unknown; response_metadata?: { next_cursor?: unknown } };
        if (
          !Array.isArray(result.members) ||
          !result.members.every((member) => typeof member === "string")
        ) {
          throw new Error("Slack conversations.members response did not include a members array");
        }
        members.push(...(result.members as string[]));
        const nextCursor = result.response_metadata?.next_cursor;
        if (nextCursor !== undefined && typeof nextCursor !== "string") {
          throw new Error("Slack conversations.members response included an invalid cursor");
        }
        cursor = nextCursor?.trim() || undefined;
        if (cursor && seenCursors.has(cursor)) {
          throw new Error("Slack conversations.members returned a repeated cursor");
        }
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      return members;
    },
    leaveChannelAsUser: (channelId, userToken): Promise<LeaveChannelOutcome> =>
      call(async () => {
        const userWeb = userWebFactory(userToken);
        try {
          await userWeb.conversations.leave({ channel: channelId });
          return "left";
        } catch (error) {
          const code = slackErrorCode(error);
          // Already gone is an idempotent success; a dead token is reported so
          // the caller can drop it. Anything else is transient — let it retry.
          if (code === "not_in_channel") return "already_out";
          if (code && DEAD_TOKEN_ERRORS.has(code)) return "invalid_token";
          throw error;
        }
      }),
    postMessage: (msg: SlackMessage) =>
      postPacer.run(msg.channel, () =>
        call(async () => {
          const customize = Boolean(msg.username || msg.iconUrl);
          // Author the message as the linked Slack user when provided. This needs
          // the `chat:write.customize` scope; if it isn't granted Slack rejects the
          // post with `missing_scope`, so fall back to a plain bot post rather than
          // letting comment mirroring break (poisoning the job).
          const post = (withAuthor: boolean) =>
            withWritableChannel(msg.channel, () =>
              web.apiCall("chat.postMessage", {
                channel: msg.channel,
                text: msg.text,
                blocks: msg.blocks,
                thread_ts: msg.threadTs,
                client_msg_id: msg.clientMsgId,
                username: withAuthor ? msg.username : undefined,
                icon_url: withAuthor ? msg.iconUrl : undefined,
              }),
            );
          let res: { ts?: unknown };
          try {
            res = (await post(customize)) as { ts?: unknown };
          } catch (error) {
            if (customize && slackErrorCode(error) === "missing_scope") {
              res = (await post(false)) as { ts?: unknown };
            } else {
              throw error;
            }
          }
          return { ts: requireNonEmptyString(res.ts, "chat.postMessage timestamp") };
        }),
      ),
    lookupUserByEmail: (email) =>
      call(async () => {
        return lookupSlackUserByEmail(web.users, email);
      }),
    lookupUserName: (userId) =>
      call(async () => {
        return lookupSlackUserName(web.users, userId);
      }),
    lookupUserProfile: (userId) =>
      call(async () => {
        return lookupSlackUserProfile(web.users, userId);
      }),
  };
}
