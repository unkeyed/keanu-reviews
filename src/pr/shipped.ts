import type { Db } from "#db";
import type { Logger, PrId } from "#lib";
import { type PrView, type SlackGateway, channelSink, createLedger, keys } from "#slack";

export interface ShippedDeps {
  db: Db;
  slack: SlackGateway;
  logger: Logger;
  /** Channel ID or name that receives merge announcements; unset disables it. */
  shippedChannel?: string;
}

export interface ShippedInput {
  prId: PrId;
  pr: PrView;
  /** The author's plain Slack display name, else login. Looked up only when posting. */
  authorLabel: () => Promise<string>;
}

/**
 * Announce a merged PR in the shared #shipped channel (R12). Fires only on
 * merge (the caller gates on the merged transition) and is idempotent per PR,
 * so a redelivered merge event does not double-post.
 */
export async function notifyShipped(deps: ShippedDeps, input: ShippedInput): Promise<void> {
  if (!deps.shippedChannel) return;
  const ledger = createLedger(deps.db);
  const key = keys.shipped(input.prId);
  if (await ledger.sentTs(key)) return;

  const channelId = await deps.slack.resolveChannel(deps.shippedChannel);
  if (!channelId) {
    deps.logger.warn("shipped channel not found; skipping announcement", {
      shippedChannel: deps.shippedChannel,
    });
    return;
  }

  await ledger.deliver(key, channelSink(deps.slack, channelId), async () => ({
    message: { kind: "shipped", pr: input.pr, authorLabel: await input.authorLabel() },
  }));
}
