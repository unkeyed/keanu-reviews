import type { Db } from "../db/client.ts";
import {
  type MessageEffectInput,
  claimMessageEffect,
  completeMessageEffect,
  findMessageEffect,
  releaseMessageEffect,
} from "../db/repositories/messages.ts";
import type { SlackClient, SlackMessage } from "./client.ts";

export interface DeliveredSlackMessage {
  slackTs: string;
  posted: boolean;
}

/**
 * Deliver one durable Slack effect. The DB row is only marked sent after Slack
 * returns a real timestamp. Crashes or ambiguous transport failures can retry
 * with the same deterministic client_msg_id, so Slack can deduplicate the post.
 */
export async function deliverSlackMessage(
  db: Db,
  slack: SlackClient,
  effect: MessageEffectInput,
  message: SlackMessage,
  beforePost?: () => Promise<void>,
): Promise<DeliveredSlackMessage> {
  const claim = await claimMessageEffect(db, effect);
  if (!claim) {
    const existing = await findMessageEffect(db, effect);
    if (existing?.status === "sent" && existing.slackTs) {
      return { slackTs: existing.slackTs, posted: false };
    }
    throw new Error(`Slack effect is already being delivered: ${effect.kind}`);
  }

  try {
    await beforePost?.();
    const result = await slack.postMessage({ ...message, clientMsgId: claim.clientMsgId });
    if (!result.ts) throw new Error("Slack accepted a message without returning a timestamp");
    if (!(await completeMessageEffect(db, claim, result.ts))) {
      throw new Error(`Slack effect lease was lost before completion: ${effect.kind}`);
    }
    return { slackTs: result.ts, posted: true };
  } catch (error) {
    await releaseMessageEffect(db, claim);
    throw error;
  }
}
