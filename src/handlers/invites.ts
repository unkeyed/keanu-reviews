import type { Logger } from "../logger.ts";
import type { SlackClient } from "../slack/client.ts";

/**
 * Invite users into a PR channel. A user Slack permanently refuses, such as a
 * guest or a deactivated account, is logged and skipped so that one user cannot
 * block the channel lifecycle or the message that follows the invite.
 */
export async function inviteToChannel(
  deps: { slack: SlackClient; logger: Logger },
  channelId: string,
  userIds: string[],
  context: Record<string, unknown>,
): Promise<void> {
  for (const refused of await deps.slack.inviteUsers(channelId, userIds)) {
    deps.logger.warn("Slack refused to invite user into channel", {
      ...context,
      channelId,
      userId: refused.userId,
      slackError: refused.error,
    });
  }
}
