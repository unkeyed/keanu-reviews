import type {
  LeaveChannelOutcome,
  SlackClient,
  SlackMessage,
  SlackMessageUpdate,
  SlackUserProfile,
} from "../slack/client.ts";

/** In-memory Slack client for offline tests. Records every call for assertions. */
export class FakeSlackClient implements SlackClient {
  channels: { id: string; name: string; archived: boolean; topic?: string }[] = [];
  // Stored posts carry the assigned `ts` so tests can assert threading targets.
  messages: (SlackMessage & { ts: string })[] = [];
  invites: { channelId: string; userIds: string[] }[] = [];
  // Every chat.update call, for asserting edit-sync behavior.
  updates: SlackMessageUpdate[] = [];
  // Every chat.delete call, for asserting delete-sync behavior.
  deletes: { channel: string; ts: string; authorUserToken?: string }[] = [];
  leftMembers: { channelId: string; userId: string }[] = [];
  emailToUser = new Map<string, string>();
  userNames = new Map<string, string>();
  userProfiles = new Map<string, SlackUserProfile>();
  /** Test-set map of Slack user id -> the (decrypted) token leave calls expect. */
  userTokens = new Map<string, string>();
  /** Tokens the fake should treat as revoked/invalid. */
  invalidTokens = new Set<string>();
  private memberships = new Map<string, Set<string>>();
  private chanSeq = 0;
  private tsSeq = 0;
  private clientMessageIds = new Map<string, string>();

  async createChannel(name: string): Promise<{ channelId: string }> {
    if (this.channels.some((channel) => channel.name === name)) {
      throw { data: { error: "name_taken" } };
    }
    const id = `C${++this.chanSeq}`;
    this.channels.push({ id, name, archived: false });
    return { channelId: id };
  }
  async findChannelByName(name: string): Promise<string | undefined> {
    return this.channels.find((channel) => channel.name === name)?.id;
  }
  async renameChannel(channelId: string, name: string): Promise<void> {
    const ch = this.channels.find((c) => c.id === channelId);
    if (ch) ch.name = name;
  }
  async setTopic(channelId: string, topic: string): Promise<void> {
    const ch = this.channels.find((c) => c.id === channelId);
    if (ch) ch.topic = topic;
  }
  async archiveChannel(channelId: string): Promise<void> {
    const ch = this.channels.find((c) => c.id === channelId);
    if (ch) ch.archived = true;
  }
  async unarchiveChannel(channelId: string): Promise<void> {
    const ch = this.channels.find((c) => c.id === channelId);
    if (ch) ch.archived = false;
  }
  async inviteUsers(channelId: string, userIds: string[]): Promise<void> {
    const missing = userIds.filter(
      (userId) =>
        !this.invites.some(
          (invite) => invite.channelId === channelId && invite.userIds.includes(userId),
        ),
    );
    if (missing.length > 0) this.invites.push({ channelId, userIds: missing });
    const members = this.memberships.get(channelId) ?? new Set<string>();
    for (const userId of userIds) members.add(userId);
    this.memberships.set(channelId, members);
  }
  async listChannelMembers(channelId: string): Promise<string[]> {
    return [...(this.memberships.get(channelId) ?? [])];
  }
  async leaveChannelAsUser(channelId: string, userToken: string): Promise<LeaveChannelOutcome> {
    if (this.invalidTokens.has(userToken)) return "invalid_token";
    const userId = [...this.userTokens.entries()].find(([, token]) => token === userToken)?.[0];
    const members = this.memberships.get(channelId);
    if (!userId || !members?.has(userId)) return "already_out";
    members.delete(userId);
    this.leftMembers.push({ channelId, userId });
    return "left";
  }
  async postMessage(msg: SlackMessage): Promise<{ ts: string }> {
    if (msg.clientMsgId) {
      const existing = this.clientMessageIds.get(msg.clientMsgId);
      if (existing) return { ts: existing };
    }
    // Posting AS the user via their token: a revoked token fails (so callers drop
    // it and fall back to the bot), and a non-member is auto-invited first
    // (chat.postMessage would otherwise return not_in_channel).
    if (msg.authorUserToken) {
      if (this.invalidTokens.has(msg.authorUserToken)) {
        throw { data: { error: "token_revoked" } };
      }
      if (msg.authorUserId) {
        const members = this.memberships.get(msg.channel) ?? new Set<string>();
        if (!members.has(msg.authorUserId)) {
          this.invites.push({ channelId: msg.channel, userIds: [msg.authorUserId] });
          members.add(msg.authorUserId);
          this.memberships.set(msg.channel, members);
        }
      }
    }
    if (this.channel(msg.channel)?.archived) {
      throw { data: { error: "is_archived" } };
    }
    const ts = `ts-${++this.tsSeq}`;
    this.messages.push({ ...msg, ts });
    if (msg.clientMsgId) this.clientMessageIds.set(msg.clientMsgId, ts);
    return { ts };
  }
  async updateMessage(update: SlackMessageUpdate): Promise<void> {
    if (update.authorUserToken && this.invalidTokens.has(update.authorUserToken)) {
      throw { data: { error: "token_revoked" } };
    }
    const msg = this.messages.find((m) => m.ts === update.ts && m.channel === update.channel);
    if (!msg) throw { data: { error: "message_not_found" } };
    this.updates.push(update);
    msg.text = update.text;
    msg.blocks = update.blocks;
  }
  async deleteMessage(channel: string, ts: string, authorUserToken?: string): Promise<void> {
    if (authorUserToken && this.invalidTokens.has(authorUserToken)) {
      throw { data: { error: "token_revoked" } };
    }
    const idx = this.messages.findIndex((m) => m.ts === ts && m.channel === channel);
    if (idx === -1) throw { data: { error: "message_not_found" } };
    this.deletes.push({ channel, ts, authorUserToken });
    this.messages.splice(idx, 1);
  }
  async lookupUserByEmail(email: string): Promise<string | undefined> {
    return this.emailToUser.get(email);
  }
  async lookupUserName(userId: string): Promise<string | undefined> {
    return this.userNames.get(userId);
  }
  async lookupUserProfile(userId: string): Promise<SlackUserProfile | undefined> {
    const explicit = this.userProfiles.get(userId);
    if (explicit) return explicit;
    const name = this.userNames.get(userId);
    return name ? { name } : undefined;
  }

  channel(id: string) {
    return this.channels.find((c) => c.id === id);
  }
}
