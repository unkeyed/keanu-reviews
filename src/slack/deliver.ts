import { Retry, leaseWaitMs } from "#lib";
import type { Db } from "../db/client.ts";
import {
  MESSAGE_EFFECT_LEASE_MS,
  type MessageEffectInput,
  claimMessageEffect,
  completeMessageEffect,
  findMessageEffect,
  releaseMessageEffect,
} from "../db/repositories/messages.ts";
import { BOT, type Poster, type RenderedMessage, type SlackGateway } from "./gateway.ts";

export interface SlackMessage extends RenderedMessage {
  channel: string;
  threadTs?: string;
  poster?: Poster;
}

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
  slack: SlackGateway,
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
    throw new Retry(
      `Slack effect is already being delivered: ${effect.kind}`,
      { kind: effect.kind },
      leaseWaitMs(existing?.claimedAt, MESSAGE_EFFECT_LEASE_MS, new Date()),
    );
  }

  try {
    await beforePost?.();
    const ts = await slack.post(
      message.channel,
      { text: message.text, blocks: message.blocks, images: message.images },
      { poster: message.poster ?? BOT, threadTs: message.threadTs, clientMsgId: claim.clientMsgId },
    );
    if (!(await completeMessageEffect(db, claim, ts))) {
      throw new Error(`Slack effect lease was lost before completion: ${effect.kind}`);
    }
    return { slackTs: ts, posted: true };
  } catch (error) {
    await releaseMessageEffect(db, claim);
    throw error;
  }
}
