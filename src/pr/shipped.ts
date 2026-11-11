import type { PrId } from "#lib";
import { type PrView, channelSink, createLedger, keys } from "#slack";
import type { PrDeps } from "./converge.ts";

export type ShippedDeps = Pick<PrDeps, "db" | "slack" | "logger" | "shippedChannel">;

export interface ShippedInput {
  prId: PrId;
  pr: PrView;
  authorLabel: () => Promise<string>;
}

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
