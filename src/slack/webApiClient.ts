import { WebClient } from "@slack/web-api";
import type { SlackClient, SlackMessage } from "./client.ts";
import { Pacer, withRetry } from "./rateLimiter.ts";

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
        await web.conversations.archive({ channel: channelId });
      }),
    unarchiveChannel: (channelId) =>
      call(async () => {
        await web.conversations.unarchive({ channel: channelId });
      }),
    inviteUsers: (channelId, userIds) =>
      call(async () => {
        if (userIds.length > 0) {
          await web.conversations.invite({ channel: channelId, users: userIds.join(",") });
        }
      }),
    postMessage: (msg: SlackMessage) =>
      postPacer.run(msg.channel, () =>
        call(async () => {
          const res = await web.chat.postMessage({
            channel: msg.channel,
            text: msg.text,
            blocks: msg.blocks as never,
            thread_ts: msg.threadTs,
          });
          return { ts: res.ts ?? "" };
        }),
      ),
    lookupUserByEmail: (email) =>
      call(async () => {
        try {
          const res = await web.users.lookupByEmail({ email });
          return res.user?.id;
        } catch {
          return undefined; // users_not_found -> miss
        }
      }),
  };
}
