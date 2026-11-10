import type { Logger } from "#lib";
import type { SlackGateway } from "#slack";

/**
 * Invite users into a PR channel. A user Slack permanently refuses, such as a
 * guest or a deactivated account, is logged and skipped so that one user cannot
 * block the channel lifecycle or the message that follows the invite.
 */
export async function inviteToChannel(
  deps: { slack: SlackGateway; logger: Logger },
  channelId: string,
  userIds: string[],
  context: Record<string, unknown>,
): Promise<void> {
  for (const refused of await deps.slack.invite(channelId, userIds)) {
    deps.logger.warn("Slack refused to invite user into channel", {
      ...context,
      channelId,
      userId: refused.userId,
      slackError: refused.error,
    });
  }
}
