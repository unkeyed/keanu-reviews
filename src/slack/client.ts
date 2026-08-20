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
  // Author overrides so a mirrored comment appears to come from the linked Slack
  // user (their name + avatar) instead of the bot. Require `chat:write.customize`.
  username?: string;
  iconUrl?: string;
}

/** A Slack user's display name and avatar, for authoring mirrored comments. */
export interface SlackUserProfile {
  name?: string;
  iconUrl?: string;
}

/**
 * Result of asking a user (via their own token) to leave a channel:
 * - `left`: the user left the channel now.
 * - `already_out`: the user was not a member (a no-op success).
 * - `invalid_token`: the user's stored token is dead (revoked/invalid); the
 *   caller should drop it so it isn't retried on every future archive.
 */
export type LeaveChannelOutcome = "left" | "already_out" | "invalid_token";

export interface SlackClient {
  createChannel(name: string): Promise<{ channelId: string }>;
  findChannelByName(name: string): Promise<string | undefined>;
  renameChannel(channelId: string, name: string): Promise<void>;
  setTopic(channelId: string, topic: string): Promise<void>;
  archiveChannel(channelId: string): Promise<void>;
  unarchiveChannel(channelId: string): Promise<void>;
  inviteUsers(channelId: string, userIds: string[]): Promise<void>;
  /** All member IDs of a channel (bot token, paginated). Includes the bot. */
  listChannelMembers(channelId: string): Promise<string[]>;
  /** Make a specific user leave `channelId` using their own token (silent). */
  leaveChannelAsUser(channelId: string, userToken: string): Promise<LeaveChannelOutcome>;
  postMessage(msg: SlackMessage): Promise<{ ts: string }>;
  lookupUserByEmail(email: string): Promise<string | undefined>;
  /** The user's Slack display name (no ping), or undefined if unknown. */
  lookupUserName(userId: string): Promise<string | undefined>;
  /** The user's display name + avatar, for authoring a mirrored comment as them. */
  lookupUserProfile(userId: string): Promise<SlackUserProfile | undefined>;
}
