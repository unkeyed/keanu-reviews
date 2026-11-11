import type { Logger } from "#lib";
import { type ChannelSink, type Message, type SlackGateway, render } from "#slack";

/**
 * The writer for one PR's channel: posts, edits, deletes and invites. Healing
 * a write the channel refused (bot removed, channel archived) stays in the
 * Slack gateway, which applies it to every bot write, lifecycle calls and the
 * #shipped post included, so it has one owner.
 */
export interface PrChannel extends ChannelSink {
  /** Slack only lets a message be edited or deleted with the token that posted it. */
  update(ts: string, message: Message, userToken?: string): Promise<void>;
  remove(ts: string, userToken?: string): Promise<void>;
  /**
   * A user Slack permanently refuses, such as a guest or a deactivated
   * account, is logged and skipped so that one user cannot block the channel
   * lifecycle or the message that follows the invite.
   */
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
    update: (ts, message, userToken) => slack.update(channel, ts, render(message), userToken),
    remove: (ts, userToken) => slack.remove(channel, ts, userToken),
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
