import type { ChatPostMessageArguments } from "@slack/web-api";

type ChatPostMessageWithBlocks = Extract<ChatPostMessageArguments, { blocks: unknown[] }>;
export type SlackBlock = ChatPostMessageWithBlocks["blocks"][number];

/**
 * Slack surface the bot depends on (U4-U9). Defined as an interface so handlers
 * are testable with a fake and the real Web API client stays at the edge. All
 * calls are one-way outbound — the bot never reads GitHub through here.
 */
export interface SlackMessage {
  channel: string;
  text: string; // required notification fallback
  blocks?: SlackBlock[];
  threadTs?: string; // parent ts only, never a reply's (KTD5 threading)
  clientMsgId?: string; // deterministic idempotency key for ambiguous retries
}

export interface SlackClient {
  createChannel(name: string): Promise<{ channelId: string }>;
  findChannelByName(name: string): Promise<string | undefined>;
  renameChannel(channelId: string, name: string): Promise<void>;
  setTopic(channelId: string, topic: string): Promise<void>;
  /** Remove human members before archiving so Slack does not notify them. */
  removeChannelMembers(channelId: string): Promise<void>;
  archiveChannel(channelId: string): Promise<void>;
  unarchiveChannel(channelId: string): Promise<void>;
  inviteUsers(channelId: string, userIds: string[]): Promise<void>;
  postMessage(msg: SlackMessage): Promise<{ ts: string }>;
  lookupUserByEmail(email: string): Promise<string | undefined>;
}
