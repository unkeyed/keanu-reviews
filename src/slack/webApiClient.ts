import { WebClient } from "@slack/web-api";
import type { SlackClient, SlackMessage } from "./client.ts";
import { Pacer, withRetry } from "./rateLimiter.ts";

export function isSlackChannelAlreadyInState(
  error: unknown,
  expectedCode: "already_archived" | "not_archived",
): boolean {
  return (error as { data?: { error?: string } })?.data?.error === expectedCode;
}

interface SlackUserLookupApi {
  lookupByEmail(input: { email: string }): Promise<{ user?: { id?: string } }>;
}

/** Slack uses `users_not_found` for a legitimate lookup miss; all other errors are operational. */
export async function lookupSlackUserByEmail(
  users: SlackUserLookupApi,
  email: string,
): Promise<string | undefined> {
  try {
    const result = await users.lookupByEmail({ email });
    return result.user?.id;
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
export function createWebApiSlackClient(token: string): SlackClient {
  const web = new WebClient(token);
  const postPacer = new Pacer(1000);
  const createPacer = new Pacer(3000); // ~20/min Tier-2 headroom

  const toRetryable = (e: unknown): unknown => {
    const err = e as { code?: string; retryAfter?: number };
    if (err?.code === "slack_webapi_rate_limited") {
      return { status: 429, retryAfterSeconds: err.retryAfter ?? 1 };
    }
    return e;
  };
  const call = <T>(fn: () => Promise<T>): Promise<T> =>
    withRetry(() =>
      fn().catch((e) => {
        throw toRetryable(e);
      }),
    );

  return {
    createChannel: (name) =>
      createPacer.run("create", () =>
        call(async () => {
          const res = await web.conversations.create({ name });
          return { channelId: res.channel?.id ?? "" };
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
          // The Web API accepts client_msg_id even though the generated method
          // arguments in this SDK version omit it, so use the generic call.
          const res = (await web.apiCall("chat.postMessage", {
            channel: msg.channel,
            text: msg.text,
            blocks: msg.blocks as never,
            thread_ts: msg.threadTs,
            client_msg_id: msg.clientMsgId,
          })) as { ts?: unknown };
          return { ts: typeof res.ts === "string" ? res.ts : "" };
        }),
      ),
    lookupUserByEmail: (email) =>
      call(async () => {
        return lookupSlackUserByEmail(web.users, email);
      }),
  };
}
