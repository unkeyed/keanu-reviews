import type { Logger } from "../logger.ts";
import type { SlackClient } from "./client.ts";

export interface MemberCleanupDeps {
  slack: SlackClient;
  logger: Logger;
  /** Decrypted Slack user token for a member, or undefined if none is stored. */
  getUserToken: (slackUserId: string) => Promise<string | undefined>;
  /** Drop a token Slack reported dead so it isn't retried on future archives. */
  onInvalidToken: (slackUserId: string) => Promise<void>;
}

export interface MemberCleanupSummary {
  members: number;
  left: number;
  alreadyOut: number;
  noToken: number;
  invalidToken: number;
  failed: number;
}

/**
 * Make every channel member who has authorized us leave the channel using their
 * own token, so the subsequent archive is silent (no Slackbot "archived the
 * channel" ping). Best-effort by design: a member we can't move — no token, a
 * dead token, or a transient error — is simply left in place. They receive the
 * one archive notification, and archiving is never blocked. As more people run
 * `/link-slack`, the archive gets quieter, matching Axolo's model.
 */
export async function quietlyRemoveMembers(
  deps: MemberCleanupDeps,
  channelId: string,
): Promise<MemberCleanupSummary> {
  const summary: MemberCleanupSummary = {
    members: 0,
    left: 0,
    alreadyOut: 0,
    noToken: 0,
    invalidToken: 0,
    failed: 0,
  };

  let members: string[];
  try {
    members = await deps.slack.listChannelMembers(channelId);
  } catch (err) {
    // If we can't even list members, skip cleanup and let the archive proceed.
    deps.logger.warn("quiet archive: listing members failed; archiving with members present", {
      channelId,
      err: err instanceof Error ? err.message : String(err),
    });
    return summary;
  }
  summary.members = members.length;

  for (const member of members) {
    let token: string | undefined;
    try {
      token = await deps.getUserToken(member);
    } catch (err) {
      summary.failed += 1;
      deps.logger.warn("quiet archive: reading a member token failed", {
        channelId,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!token) {
      summary.noToken += 1;
      continue;
    }

    try {
      const outcome = await deps.slack.leaveChannelAsUser(channelId, token);
      if (outcome === "left") summary.left += 1;
      else if (outcome === "already_out") summary.alreadyOut += 1;
      else {
        summary.invalidToken += 1;
        await deps.onInvalidToken(member);
      }
    } catch (err) {
      summary.failed += 1;
      deps.logger.warn("quiet archive: a member leave failed", {
        channelId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info("quiet archive member cleanup", { channelId, ...summary });
  return summary;
}
