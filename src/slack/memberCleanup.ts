import { type Logger, errMessage } from "#lib";
import type { SlackGateway } from "./gateway.ts";

export interface MemberCleanupDeps {
  slack: SlackGateway;
  logger: Logger;
  getUserTokens: (slackUserIds: readonly string[]) => Promise<Map<string, string>>;
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
    members = await deps.slack.members(channelId);
  } catch (err) {
    deps.logger.warn("quiet archive: listing members failed; archiving with members present", {
      channelId,
      err: errMessage(err),
    });
    return summary;
  }
  summary.members = members.length;

  let tokens: Map<string, string>;
  try {
    tokens = await deps.getUserTokens(members);
  } catch (err) {
    summary.failed = members.length;
    deps.logger.warn("quiet archive: reading member tokens failed", {
      channelId,
      err: errMessage(err),
    });
    deps.logger.info("quiet archive member cleanup", { channelId, ...summary });
    return summary;
  }

  for (const member of members) {
    const token = tokens.get(member);
    if (!token) {
      summary.noToken += 1;
      continue;
    }

    try {
      const outcome = await deps.slack.leave(channelId, token);
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
        err: errMessage(err),
      });
    }
  }

  deps.logger.info("quiet archive member cleanup", { channelId, ...summary });
  return summary;
}
