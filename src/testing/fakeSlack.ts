import {
  type LeaveOutcome,
  type MessageImage,
  type Poster,
  type RefusedInvite,
  type RenderedMessage,
  SlackApiError,
  type SlackBlock,
  type SlackGateway,
  type SlackProfile,
} from "#slack";

/** One recorded post, flattened so tests read the poster's fields directly. */
export interface FakePost {
  channel: string;
  ts: string;
  text: string;
  blocks?: SlackBlock[];
  images?: readonly MessageImage[];
  threadTs?: string;
  clientMsgId: string;
  username?: string;
  iconUrl?: string;
  authorUserToken?: string;
  authorUserId?: string;
}

export interface FakeUpdate {
  channel: string;
  ts: string;
  text: string;
  blocks?: SlackBlock[];
  images?: readonly MessageImage[];
  authorUserToken?: string;
}

const fail = (method: string, code: string) => new SlackApiError(method, code);

/** In-memory Slack gateway for offline tests. Records every call for assertions. */
export class FakeSlackGateway implements SlackGateway {
  channels: { id: string; name: string; archived: boolean; topic?: string }[] = [];
  messages: FakePost[] = [];
  invites: { channelId: string; userIds: string[] }[] = [];
  updates: FakeUpdate[] = [];
  deletes: { channel: string; ts: string; authorUserToken?: string }[] = [];
  leftMembers: { channelId: string; userId: string }[] = [];
  emailToUser = new Map<string, string>();
  profiles = new Map<string, SlackProfile>();
  /** Slack user id -> the (decrypted) token leave calls expect. */
  userTokens = new Map<string, string>();
  /** Tokens the fake treats as revoked. */
  invalidTokens = new Set<string>();
  /** Slack user id -> the error Slack returns when inviting that user (e.g. a guest). */
  uninvitableUsers = new Map<string, string>();
  private memberships = new Map<string, Set<string>>();
  private resolved = new Map<string, string>();
  private chanSeq = 0;
  private tsSeq = 0;
  private clientMessageIds = new Map<string, string>();

  async createChannel(name: string): Promise<string> {
    if (this.channels.some((channel) => channel.name === name)) {
      throw fail("conversations.create", "name_taken");
    }
    const id = `C${++this.chanSeq}`;
    this.channels.push({ id, name, archived: false });
    return id;
  }
  async findChannelByName(name: string): Promise<string | undefined> {
    return this.channels.find((channel) => channel.name === name)?.id;
  }
  async resolveChannel(idOrName: string): Promise<string | undefined> {
    if (/^[CGD][A-Z0-9]{5,}$/.test(idOrName)) return idOrName;
    const cached = this.resolved.get(idOrName);
    if (cached) return cached;
    const id = await this.findChannelByName(idOrName.replace(/^#/, ""));
    if (id) this.resolved.set(idOrName, id);
    return id;
  }
  async rename(channelId: string, name: string): Promise<void> {
    const ch = this.channel(channelId);
    if (ch) ch.name = name;
  }
  async setTopic(channelId: string, topic: string): Promise<void> {
    const ch = this.channel(channelId);
    if (ch) ch.topic = topic;
  }
  async archive(channelId: string): Promise<void> {
    const ch = this.channel(channelId);
    if (ch) ch.archived = true;
  }
  async unarchive(channelId: string): Promise<void> {
    const ch = this.channel(channelId);
    if (ch) ch.archived = false;
  }
  async isArchived(channelId: string): Promise<boolean | undefined> {
    return this.channel(channelId)?.archived;
  }
  async invite(channelId: string, requested: readonly string[]): Promise<RefusedInvite[]> {
    const refused = requested.flatMap((userId) => {
      const error = this.uninvitableUsers.get(userId);
      return error ? [{ userId, error }] : [];
    });
    const userIds = requested.filter((userId) => !this.uninvitableUsers.has(userId));
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
    return refused;
  }
  async members(channelId: string): Promise<string[]> {
    return [...(this.memberships.get(channelId) ?? [])];
  }
  async leave(channelId: string, userToken: string): Promise<LeaveOutcome> {
    if (this.invalidTokens.has(userToken)) return "invalid_token";
    const userId = [...this.userTokens.entries()].find(([, token]) => token === userToken)?.[0];
    const members = this.memberships.get(channelId);
    if (!userId || !members?.has(userId)) return "already_out";
    members.delete(userId);
    this.leftMembers.push({ channelId, userId });
    return "left";
  }
  async post(
    channel: string,
    msg: RenderedMessage,
    opts: { poster: Poster; threadTs?: string; clientMsgId: string },
  ): Promise<string> {
    const existing = this.clientMessageIds.get(opts.clientMsgId);
    if (existing) return existing;
    const { poster } = opts;
    // Posting as the user: a revoked token fails (so callers drop it and fall
    // back to the bot), and a non-member is invited first, as the gateway does.
    if (poster.kind === "user") {
      if (this.invalidTokens.has(poster.token)) throw fail("chat.postMessage", "token_revoked");
      const members = this.memberships.get(channel) ?? new Set<string>();
      if (!members.has(poster.userId)) {
        this.invites.push({ channelId: channel, userIds: [poster.userId] });
        members.add(poster.userId);
        this.memberships.set(channel, members);
      }
    }
    if (this.channel(channel)?.archived) throw fail("chat.postMessage", "is_archived");
    const ts = `ts-${++this.tsSeq}`;
    this.messages.push({
      channel,
      ts,
      text: msg.text,
      blocks: msg.blocks,
      images: msg.images,
      threadTs: opts.threadTs,
      clientMsgId: opts.clientMsgId,
      username: poster.kind === "bot-as" ? poster.username : undefined,
      iconUrl: poster.kind === "bot-as" ? poster.iconUrl : undefined,
      authorUserToken: poster.kind === "user" ? poster.token : undefined,
      authorUserId: poster.kind === "user" ? poster.userId : undefined,
    });
    this.clientMessageIds.set(opts.clientMsgId, ts);
    return ts;
  }
  async update(
    channel: string,
    ts: string,
    msg: RenderedMessage,
    authorUserToken?: string,
  ): Promise<void> {
    if (authorUserToken && this.invalidTokens.has(authorUserToken)) {
      throw fail("chat.update", "token_revoked");
    }
    const posted = this.messages.find((m) => m.ts === ts && m.channel === channel);
    if (!posted) throw fail("chat.update", "message_not_found");
    this.updates.push({ channel, ts, ...msg, authorUserToken });
    posted.text = msg.text;
    posted.blocks = msg.blocks;
  }
  async remove(channel: string, ts: string, authorUserToken?: string): Promise<void> {
    if (authorUserToken && this.invalidTokens.has(authorUserToken)) {
      throw fail("chat.delete", "token_revoked");
    }
    const idx = this.messages.findIndex((m) => m.ts === ts && m.channel === channel);
    if (idx === -1) throw fail("chat.delete", "message_not_found");
    this.deletes.push({ channel, ts, authorUserToken });
    this.messages.splice(idx, 1);
  }
  async lookupByEmail(email: string): Promise<string | undefined> {
    return this.emailToUser.get(email);
  }
  async profile(userId: string): Promise<SlackProfile | undefined> {
    return this.profiles.get(userId);
  }

  channel(id: string) {
    return this.channels.find((c) => c.id === id);
  }
}
