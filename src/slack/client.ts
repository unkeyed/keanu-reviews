/**
 * Slack surface the bot depends on (U4-U9). Defined as an interface so handlers
 * are testable with a fake and the real Web API client stays at the edge. All
 * calls are one-way outbound — the bot never reads GitHub through here.
 */
export interface SlackMessage {
  channel: string;
  text: string; // required notification fallback
  blocks?: unknown[];
  threadTs?: string; // parent ts only, never a reply's (KTD5 threading)
}

export interface SlackClient {
  createChannel(name: string): Promise<{ channelId: string }>;
  renameChannel(channelId: string, name: string): Promise<void>;
  archiveChannel(channelId: string): Promise<void>;
  unarchiveChannel(channelId: string): Promise<void>;
  inviteUsers(channelId: string, userIds: string[]): Promise<void>;
  postMessage(msg: SlackMessage): Promise<{ ts: string }>;
  lookupUserByEmail(email: string): Promise<string | undefined>;
}
