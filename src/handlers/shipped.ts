import type { Db } from "../db/client.ts";
import type { Logger } from "../logger.ts";
import { sanitizeLinkLabel, sanitizeMrkdwn } from "../slack/blocks.ts";
import type { SlackClient } from "../slack/client.ts";
import { deliverSlackMessage } from "../slack/deliver.ts";

export interface ShippedDeps {
  db: Db;
  slack: SlackClient;
  logger: Logger;
  /** Channel ID or name that receives merge announcements; unset disables it. */
  shippedChannel?: string;
}

export interface ShippedInput {
  prId: string;
  repoFullName: string;
  number: number;
  title: string;
  htmlUrl: string;
  authorMention: string; // plain Slack display name (no @-ping), else the login
}

const looksLikeChannelId = (value: string): boolean => /^[CGD][A-Z0-9]{5,}$/.test(value);

async function resolveShippedChannel(
  slack: SlackClient,
  value: string,
): Promise<string | undefined> {
  if (looksLikeChannelId(value)) return value;
  return slack.findChannelByName(value.replace(/^#/, ""));
}

/**
 * Announce a merged PR in the shared #shipped channel (R12). Fires only on
 * merge (the caller gates on the merged transition) and is idempotent per PR,
 * so a redelivered merge event does not double-post.
 */
export async function notifyShipped(deps: ShippedDeps, input: ShippedInput): Promise<void> {
  if (!deps.shippedChannel) return;

  const channelId = await resolveShippedChannel(deps.slack, deps.shippedChannel);
  if (!channelId) {
    deps.logger.warn("shipped channel not found; skipping announcement", {
      shippedChannel: deps.shippedChannel,
    });
    return;
  }

  const label = sanitizeLinkLabel(`${input.repoFullName}#${input.number}`);
  await deliverSlackMessage(
    deps.db,
    deps.slack,
    { prId: input.prId, kind: "shipped", githubEventRef: "shipped" },
    {
      channel: channelId,
      text: sanitizeMrkdwn(`${input.repoFullName}#${input.number} ${input.title} has shipped`),
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🚢 *<${input.htmlUrl}|${label}> ${sanitizeMrkdwn(input.title)}* has shipped — by ${input.authorMention}`,
          },
        },
      ],
    },
  );
}
