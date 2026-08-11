import type { SlackClient, SlackMessage } from "../slack/client.ts";

/** In-memory Slack client for offline tests. Records every call for assertions. */
export class FakeSlackClient implements SlackClient {
  channels: { id: string; name: string; archived: boolean }[] = [];
  messages: SlackMessage[] = [];
  invites: { channelId: string; userIds: string[] }[] = [];
  emailToUser = new Map<string, string>();
  private chanSeq = 0;
  private tsSeq = 0;
  private clientMessageIds = new Map<string, string>();

  async createChannel(name: string): Promise<{ channelId: string }> {
    const id = `C${++this.chanSeq}`;
    this.channels.push({ id, name, archived: false });
    return { channelId: id };
  }
  async renameChannel(channelId: string, name: string): Promise<void> {
    const ch = this.channels.find((c) => c.id === channelId);
    if (ch) ch.name = name;
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
  }
  async postMessage(msg: SlackMessage): Promise<{ ts: string }> {
    if (msg.clientMsgId) {
      const existing = this.clientMessageIds.get(msg.clientMsgId);
      if (existing) return { ts: existing };
    }
    this.messages.push(msg);
    const ts = `ts-${++this.tsSeq}`;
    if (msg.clientMsgId) this.clientMessageIds.set(msg.clientMsgId, ts);
    return { ts };
  }
  async lookupUserByEmail(email: string): Promise<string | undefined> {
    return this.emailToUser.get(email);
  }

  channel(id: string) {
    return this.channels.find((c) => c.id === id);
  }
}
