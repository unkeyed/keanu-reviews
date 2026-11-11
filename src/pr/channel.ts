import type { Logger } from "#lib";
import { type ChannelSink, type Message, SlackApiError, type SlackGateway, render } from "#slack";

export interface PrChannel extends ChannelSink {
  /**
   * Slack only lets a message be edited or deleted with the token that posted
   * it. The author's token is tried first; when Slack refuses it, the bot
   * posted the message before the author linked, so the bot tries once.
   */
  update(ts: string, message: Message, userToken?: string): Promise<void>;
  remove(ts: string, userToken?: string): Promise<void>;
  invite(userIds: readonly string[], context: Record<string, unknown>): Promise<void>;
}

export function prChannel(
  deps: { slack: SlackGateway; logger: Logger },
  channel: string,
): PrChannel {
  const { slack, logger } = deps;
  return {
    channel,
    post: (msg, opts) => slack.post(channel, msg, opts),
    update: (ts, message, userToken) =>
      thenBot(userToken, "cant_update_message", (token) =>
        slack.update(channel, ts, render(message), token),
      ),
    remove: (ts, userToken) =>
      thenBot(userToken, "cant_delete_message", (token) => slack.remove(channel, ts, token)),
    async invite(userIds, context) {
      for (const refused of await slack.invite(channel, userIds)) {
        logger.warn("Slack refused to invite user into channel", {
          ...context,
          channelId: channel,
          userId: refused.userId,
          slackError: refused.error,
        });
      }
    },
  };
}

async function thenBot(
  userToken: string | undefined,
  refusal: string,
  op: (userToken: string | undefined) => Promise<void>,
): Promise<void> {
  try {
    await op(userToken);
  } catch (error) {
    if (!userToken || !(error instanceof SlackApiError) || error.code !== refusal) throw error;
    await op(undefined);
  }
}
