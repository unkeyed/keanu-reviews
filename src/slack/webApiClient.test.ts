import { ErrorCode } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import {
  createWebApiSlackClient,
  isSlackChannelAlreadyInState,
  lookupSlackUserByEmail,
  lookupSlackUserName,
} from "./webApiClient.ts";

function fakeWebApi() {
  return {
    conversations: {
      create: vi.fn(
        async (): Promise<{ channel?: { id?: string } }> => ({ channel: { id: "C123" } }),
      ),
      join: vi.fn(async () => ({})),
      rename: vi.fn(async () => ({})),
      setTopic: vi.fn(async () => ({})),
      archive: vi.fn(async () => ({})),
      unarchive: vi.fn(async () => ({})),
      invite: vi.fn(async () => ({})),
      members: vi.fn(
        async (): Promise<{
          members?: unknown;
          response_metadata?: { next_cursor?: unknown };
        }> => ({
          members: [],
          response_metadata: { next_cursor: "" },
        }),
      ),
      leave: vi.fn(async () => ({})),
      list: vi.fn(
        async (): Promise<{
          channels?: unknown;
          response_metadata?: { next_cursor?: unknown };
        }> => ({ channels: [], response_metadata: { next_cursor: "" } }),
      ),
    },
    users: {
      lookupByEmail: vi.fn(
        async (): Promise<{ user?: { id?: string } }> => ({ user: { id: "U123" } }),
      ),
      info: vi.fn(
        async (): Promise<{
          user?: {
            name?: string;
            real_name?: string;
            profile?: { display_name?: string; real_name?: string };
          };
        }> => ({ user: { real_name: "Real Name", profile: { display_name: "Display Name" } } }),
      ),
    },
    apiCall: vi.fn(async (): Promise<{ ts?: unknown }> => ({ ts: "171234.5678" })),
  };
}

describe("Slack Web API adapter", () => {
  it("unarchives and retries a write that hits is_archived (recovers stuck channels)", async () => {
    const web = fakeWebApi();
    web.conversations.rename
      .mockRejectedValueOnce({ data: { error: "is_archived" } })
      .mockResolvedValueOnce({});
    const slack = createWebApiSlackClient("unused", { web });

    await slack.renameChannel("C123", "pr-renamed");
    expect(web.conversations.unarchive).toHaveBeenCalledWith({ channel: "C123" });
    expect(web.conversations.rename).toHaveBeenCalledTimes(2);
  });

  it("heals a channel that is both archived and left, then posts", async () => {
    const web = fakeWebApi();
    web.apiCall
      .mockRejectedValueOnce({ data: { error: "is_archived" } })
      .mockRejectedValueOnce({ data: { error: "not_in_channel" } })
      .mockResolvedValueOnce({ ts: "1.2" });
    const slack = createWebApiSlackClient("unused", { web });

    await expect(slack.postMessage({ channel: "C123", text: "hi" })).resolves.toEqual({
      ts: "1.2",
    });
    expect(web.conversations.unarchive).toHaveBeenCalledWith({ channel: "C123" });
    expect(web.conversations.join).toHaveBeenCalledWith({ channel: "C123" });
  });

  it("configures the production client to keep network retries inside durable leases", () => {
    const web = fakeWebApi();
    const webFactory = vi.fn(() => web);

    createWebApiSlackClient("xoxb-secret", { webFactory });

    expect(webFactory).toHaveBeenCalledWith("xoxb-secret", {
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: 10_000,
    });
  });

  it("maps channel operations and skips an empty invite", async () => {
    const web = fakeWebApi();
    const slack = createWebApiSlackClient("unused", { web });

    await expect(slack.createChannel("pr-123")).resolves.toEqual({ channelId: "C123" });
    await slack.renameChannel("C123", "renamed");
    await slack.archiveChannel("C123");
    await slack.unarchiveChannel("C123");
    await slack.inviteUsers("C123", ["U1", "U2"]);
    await slack.inviteUsers("C123", []);

    expect(web.conversations.create).toHaveBeenCalledWith({ name: "pr-123" });
    expect(web.conversations.rename).toHaveBeenCalledWith({ channel: "C123", name: "renamed" });
    expect(web.conversations.archive).toHaveBeenCalledWith({ channel: "C123" });
    expect(web.conversations.unarchive).toHaveBeenCalledWith({ channel: "C123" });
    expect(web.conversations.invite).toHaveBeenCalledOnce();
    expect(web.conversations.invite).toHaveBeenCalledWith({ channel: "C123", users: "U1,U2" });
  });

  it("lists channel members across pages", async () => {
    const web = fakeWebApi();
    web.conversations.members
      .mockResolvedValueOnce({ members: ["U1"], response_metadata: { next_cursor: "page-2" } })
      .mockResolvedValueOnce({ members: ["U2", "UBOT"], response_metadata: { next_cursor: "" } });
    const slack = createWebApiSlackClient("unused", { web });

    await expect(slack.listChannelMembers("C1")).resolves.toEqual(["U1", "U2", "UBOT"]);
    expect(web.conversations.members).toHaveBeenNthCalledWith(1, {
      channel: "C1",
      cursor: undefined,
      limit: 200,
    });
    expect(web.conversations.members).toHaveBeenNthCalledWith(2, {
      channel: "C1",
      cursor: "page-2",
      limit: 200,
    });
  });

  it("leaves a channel with the user's own token and reports the outcome", async () => {
    const web = fakeWebApi();
    const userLeave = vi.fn(async () => ({}));
    const tokensSeen: string[] = [];
    const slack = createWebApiSlackClient("unused", {
      web,
      userWebFactory: (token) => {
        tokensSeen.push(token);
        return { conversations: { leave: userLeave } } as never;
      },
    });

    await expect(slack.leaveChannelAsUser("C1", "xoxp-u1")).resolves.toBe("left");
    expect(userLeave).toHaveBeenCalledWith({ channel: "C1" });
    expect(tokensSeen).toEqual(["xoxp-u1"]); // the user token, not the bot token
    // The bot token must never be used to leave (that would be a kick path).
    expect(web.conversations.leave).not.toHaveBeenCalled();
  });

  it("treats not_in_channel as an idempotent leave and dead tokens as invalid", async () => {
    const web = fakeWebApi();
    const leave = vi
      .fn()
      .mockRejectedValueOnce({ data: { error: "not_in_channel" } })
      .mockRejectedValueOnce({ data: { error: "token_revoked" } })
      .mockRejectedValueOnce({ data: { error: "invalid_auth" } });
    const slack = createWebApiSlackClient("unused", {
      web,
      userWebFactory: () => ({ conversations: { leave } }) as never,
    });

    await expect(slack.leaveChannelAsUser("C1", "t")).resolves.toBe("already_out");
    await expect(slack.leaveChannelAsUser("C1", "t")).resolves.toBe("invalid_token");
    await expect(slack.leaveChannelAsUser("C1", "t")).resolves.toBe("invalid_token");
  });

  it("propagates an unexpected leave error so the durable job can retry", async () => {
    const web = fakeWebApi();
    const leave = vi.fn().mockRejectedValue({ data: { error: "internal_error" } });
    const slack = createWebApiSlackClient("unused", {
      web,
      userWebFactory: () => ({ conversations: { leave } }) as never,
    });
    await expect(slack.leaveChannelAsUser("C1", "t")).rejects.toBeTruthy();
  });

  it("finds an exact channel name across paginated public channels", async () => {
    const web = fakeWebApi();
    web.conversations.list
      .mockResolvedValueOnce({
        channels: [{ id: "C1", name: "similar-name" }],
        response_metadata: { next_cursor: "page-2" },
      })
      .mockResolvedValueOnce({
        channels: [{ id: "C2", name: "pr-unkey-api-1-deadbeef" }],
        response_metadata: { next_cursor: "" },
      });
    const slack = createWebApiSlackClient("unused", { web });

    await expect(slack.findChannelByName("pr-unkey-api-1-deadbeef")).resolves.toBe("C2");
    expect(web.conversations.list).toHaveBeenNthCalledWith(1, {
      cursor: undefined,
      exclude_archived: false,
      limit: 200,
      types: "public_channel",
    });
    expect(web.conversations.list).toHaveBeenNthCalledWith(2, {
      cursor: "page-2",
      exclude_archived: false,
      limit: 200,
      types: "public_channel",
    });
  });

  it("rejects malformed channel-list responses instead of misidentifying recovery state", async () => {
    const web = fakeWebApi();
    web.conversations.list.mockResolvedValueOnce({ response_metadata: { next_cursor: "" } });
    const slack = createWebApiSlackClient("unused", { web });

    await expect(slack.findChannelByName("pr-unkey-api-1-deadbeef")).rejects.toThrow(
      "channels array",
    );
  });

  it("forwards threading, blocks, and the idempotency key and requires a timestamp", async () => {
    const web = fakeWebApi();
    const slack = createWebApiSlackClient("unused", { web });
    const blocks = [{ type: "section" as const, text: { type: "mrkdwn" as const, text: "Hi" } }];

    await expect(
      slack.postMessage({
        channel: "C123",
        text: "fallback",
        blocks,
        threadTs: "170000.1",
        clientMsgId: "54cf8f7e-071f-4bbc-a1fe-8c5b68d8b152",
      }),
    ).resolves.toEqual({ ts: "171234.5678" });
    expect(web.apiCall).toHaveBeenCalledWith("chat.postMessage", {
      channel: "C123",
      text: "fallback",
      blocks,
      thread_ts: "170000.1",
      client_msg_id: "54cf8f7e-071f-4bbc-a1fe-8c5b68d8b152",
    });

    web.apiCall.mockResolvedValueOnce({});
    await expect(slack.postMessage({ channel: "C999", text: "missing ts" })).rejects.toThrow(
      "chat.postMessage timestamp",
    );
  });

  it("joins the channel and retries when a post hits not_in_channel", async () => {
    const web = fakeWebApi();
    web.apiCall
      .mockRejectedValueOnce({ data: { error: "not_in_channel" } })
      .mockResolvedValueOnce({ ts: "171234.5678" });
    const slack = createWebApiSlackClient("unused", { web });

    await expect(slack.postMessage({ channel: "C123", text: "CI passed" })).resolves.toEqual({
      ts: "171234.5678",
    });
    expect(web.conversations.join).toHaveBeenCalledWith({ channel: "C123" });
    expect(web.apiCall).toHaveBeenCalledTimes(2);
  });

  it("joins the channel and retries when an invite hits not_in_channel", async () => {
    const web = fakeWebApi();
    web.conversations.invite
      .mockRejectedValueOnce({ data: { error: "not_in_channel" } })
      .mockResolvedValueOnce({});
    const slack = createWebApiSlackClient("unused", { web });

    await slack.inviteUsers("C123", ["U7"]);
    expect(web.conversations.join).toHaveBeenCalledWith({ channel: "C123" });
    expect(web.conversations.invite).toHaveBeenCalledTimes(2);
  });

  it("surfaces the missing scope from a Slack missing_scope error", async () => {
    const web = fakeWebApi();
    web.apiCall.mockRejectedValueOnce({
      data: {
        error: "missing_scope",
        needed: "channels:join",
        provided: "chat:write,channels:manage",
      },
    });
    const slack = createWebApiSlackClient("unused", { web });

    await expect(slack.postMessage({ channel: "C123", text: "hi" })).rejects.toThrow(
      /missing_scope.*needed scope: channels:join.*provided scopes: chat:write,channels:manage/,
    );
  });

  it("rejects successful-looking responses that omit required identifiers", async () => {
    const web = fakeWebApi();
    web.conversations.create.mockResolvedValueOnce({});
    web.users.lookupByEmail.mockResolvedValueOnce({});
    const slack = createWebApiSlackClient("unused", { web });

    await expect(slack.createChannel("pr-123")).rejects.toThrow("conversations.create channel ID");
    await expect(slack.lookupUserByEmail("person@example.com")).rejects.toThrow(
      "users.lookupByEmail user ID",
    );
  });

  it("treats already-in-state channel responses as idempotent successes", async () => {
    const web = fakeWebApi();
    web.conversations.archive.mockRejectedValueOnce({ data: { error: "already_archived" } });
    web.conversations.unarchive.mockRejectedValueOnce({ data: { error: "not_archived" } });
    web.conversations.invite.mockRejectedValueOnce({ data: { error: "already_in_channel" } });
    const slack = createWebApiSlackClient("unused", { web });

    await expect(slack.archiveChannel("C123")).resolves.toBeUndefined();
    await expect(slack.unarchiveChannel("C123")).resolves.toBeUndefined();
    await expect(slack.inviteUsers("C123", ["U123"])).resolves.toBeUndefined();
  });

  it("recognizes Slack v8 rate-limit errors and honors a bounded Retry-After", async () => {
    const web = fakeWebApi();
    const rateLimitError = {
      code: ErrorCode.RateLimitedError,
      retryAfter: 2,
    };
    web.apiCall.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce({ ts: "171234.5678" });
    const sleep = vi.fn(async () => {});
    const slack = createWebApiSlackClient("unused", { web, sleep });

    await expect(slack.postMessage({ channel: "C123", text: "hello" })).resolves.toEqual({
      ts: "171234.5678",
    });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(web.apiCall).toHaveBeenCalledTimes(2);
  });

  it("returns long rate-limit delays to the durable job without sleeping on its lease", async () => {
    const web = fakeWebApi();
    const rateLimitError = {
      code: ErrorCode.RateLimitedError,
      retryAfter: 30,
    };
    web.apiCall.mockRejectedValue(rateLimitError);
    const sleep = vi.fn(async () => {});
    const slack = createWebApiSlackClient("unused", { web, sleep });

    await expect(slack.postMessage({ channel: "C123", text: "hello" })).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 30,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(web.apiCall).toHaveBeenCalledOnce();
  });
});

describe("Slack channel state idempotency", () => {
  it("recognizes only the expected already-in-state responses", () => {
    const archived = { data: { error: "already_archived" } };
    const active = { data: { error: "not_archived" } };

    expect(isSlackChannelAlreadyInState(archived, "already_archived")).toBe(true);
    expect(isSlackChannelAlreadyInState(active, "not_archived")).toBe(true);
    expect(isSlackChannelAlreadyInState(archived, "not_archived")).toBe(false);
    expect(isSlackChannelAlreadyInState(new Error("network"), "already_archived")).toBe(false);
  });
});

describe("Slack user lookup", () => {
  it("returns undefined only when Slack reports users_not_found", async () => {
    const lookupByEmail = vi.fn(async () => {
      throw { data: { error: "users_not_found" } };
    });

    await expect(lookupSlackUserByEmail({ lookupByEmail }, "nobody@example.com")).resolves.toBe(
      undefined,
    );
  });

  it("rethrows authentication and transport failures", async () => {
    const authError = { data: { error: "invalid_auth" } };
    const lookupByEmail = vi.fn(async () => {
      throw authError;
    });

    await expect(lookupSlackUserByEmail({ lookupByEmail }, "person@example.com")).rejects.toBe(
      authError,
    );
  });

  it("prefers display_name, then real_name, for a user's name", async () => {
    const info = vi.fn(async () => ({
      user: { real_name: "James Perkins", profile: { display_name: "jperkins" } },
    }));
    await expect(lookupSlackUserName({ info }, "U7")).resolves.toBe("jperkins");

    const infoNoDisplay = vi.fn(async () => ({
      user: { real_name: "James Perkins", profile: { display_name: "" } },
    }));
    await expect(lookupSlackUserName({ info: infoNoDisplay }, "U7")).resolves.toBe("James Perkins");
  });

  it("returns undefined for an unknown user but rethrows other errors", async () => {
    const notFound = vi.fn(async () => {
      throw { data: { error: "user_not_found" } };
    });
    await expect(lookupSlackUserName({ info: notFound }, "U0")).resolves.toBeUndefined();

    const boom = vi.fn(async () => {
      throw { data: { error: "invalid_auth" } };
    });
    await expect(lookupSlackUserName({ info: boom }, "U0")).rejects.toBeTruthy();
  });
});
