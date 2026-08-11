import { ErrorCode, WebClient, type WebClientOptions } from "@slack/web-api";
import type { SlackClient, SlackMessage } from "./client.ts";
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
}

interface SlackWebApi {
  conversations: {
    create(input: { name: string }): Promise<{ channel?: { id?: string } }>;
    rename(input: { channel: string; name: string }): Promise<unknown>;
    archive(input: { channel: string }): Promise<unknown>;
    unarchive(input: { channel: string }): Promise<unknown>;
    invite(input: { channel: string; users: string }): Promise<unknown>;
  };
  users: SlackUserLookupApi;
  apiCall(method: string, options?: Record<string, unknown>): Promise<unknown>;
}

export interface WebApiSlackClientOptions {
  /** Injected by offline adapter tests; production creates the official WebClient. */
  web?: SlackWebApi;
  webFactory?: (token: string, options: WebClientOptions) => SlackWebApi;
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
  users: SlackUserLookupApi,
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
  const postPacer = new Pacer(1000, options.sleep, options.now);
  const createPacer = new Pacer(3000, options.sleep, options.now); // ~20/min Tier-2 headroom

  const toRetryable = (e: unknown): unknown => {
    const err = e as { code?: string; retryAfter?: number };
    if (err?.code === ErrorCode.RateLimitedError) {
      return { status: 429, retryAfterSeconds: err.retryAfter ?? 1 };
    }
    return e;
  };
  const call = <T>(fn: () => Promise<T>): Promise<T> =>
    withRetry(
      () =>
        fn().catch((e) => {
          throw toRetryable(e);
        }),
      {
        maxRetries: MAX_RATE_LIMIT_RETRIES,
        maxRetryDelayMs: MAX_RATE_LIMIT_DELAY_MS,
        sleep: options.sleep,
      },
    );

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
    renameChannel: (channelId, name) =>
      call(async () => {
        await web.conversations.rename({ channel: channelId, name });
      }),
    archiveChannel: (channelId) =>
      call(async () => {
        try {
          await web.conversations.archive({ channel: channelId });
        } catch (error) {
          if (!isSlackChannelAlreadyInState(error, "already_archived")) throw error;
        }
      }),
    unarchiveChannel: (channelId) =>
      call(async () => {
        try {
          await web.conversations.unarchive({ channel: channelId });
        } catch (error) {
          if (!isSlackChannelAlreadyInState(error, "not_archived")) throw error;
        }
      }),
    inviteUsers: (channelId, userIds) =>
      call(async () => {
        if (userIds.length > 0) {
          try {
            await web.conversations.invite({ channel: channelId, users: userIds.join(",") });
          } catch (error) {
            const slackError = error as { data?: { error?: string } };
            // An ambiguous earlier invite may have succeeded. Treat Slack's
            // already-present response as the idempotent success it represents.
            if (slackError.data?.error !== "already_in_channel") throw error;
          }
        }
      }),
    postMessage: (msg: SlackMessage) =>
      postPacer.run(msg.channel, () =>
        call(async () => {
          const res = (await web.apiCall("chat.postMessage", {
            channel: msg.channel,
            text: msg.text,
            blocks: msg.blocks,
            thread_ts: msg.threadTs,
            client_msg_id: msg.clientMsgId,
          })) as { ts?: unknown };
          return { ts: requireNonEmptyString(res.ts, "chat.postMessage timestamp") };
        }),
      ),
    lookupUserByEmail: (email) =>
      call(async () => {
        return lookupSlackUserByEmail(web.users, email);
      }),
  };
}
