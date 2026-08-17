import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger.ts";
import { FakeSlackClient } from "../testing/fakeSlack.ts";
import { quietlyRemoveMembers } from "./memberCleanup.ts";

const logger = createLogger("error");

async function seededChannel() {
  const slack = new FakeSlackClient();
  const { channelId } = await slack.createChannel("merged-pr-1");
  return { slack, channelId };
}

describe("quietlyRemoveMembers", () => {
  it("makes members with tokens leave and leaves tokenless members in place", async () => {
    const { slack, channelId } = await seededChannel();
    await slack.inviteUsers(channelId, ["U_AUTH", "U_REVIEWER", "U_NOTOKEN"]);
    slack.userTokens.set("U_AUTH", "tok-auth");
    slack.userTokens.set("U_REVIEWER", "tok-rev");
    const tokens: Record<string, string> = { U_AUTH: "tok-auth", U_REVIEWER: "tok-rev" };

    const summary = await quietlyRemoveMembers(
      {
        slack,
        logger,
        getUserToken: async (id) => tokens[id],
        onInvalidToken: async () => {},
      },
      channelId,
    );

    expect(summary).toMatchObject({ members: 3, left: 2, noToken: 1, invalidToken: 0, failed: 0 });
    expect(slack.leftMembers.map((m) => m.userId).sort()).toEqual(["U_AUTH", "U_REVIEWER"]);
    // The tokenless member is still present, so the archive would still notify them only.
    expect(await slack.listChannelMembers(channelId)).toEqual(["U_NOTOKEN"]);
  });

  it("drops a token Slack reports invalid so it is not retried", async () => {
    const { slack, channelId } = await seededChannel();
    await slack.inviteUsers(channelId, ["U_DEAD"]);
    slack.invalidTokens.add("tok-dead");
    const onInvalidToken = vi.fn(async () => {});

    const summary = await quietlyRemoveMembers(
      { slack, logger, getUserToken: async () => "tok-dead", onInvalidToken },
      channelId,
    );

    expect(summary).toMatchObject({ invalidToken: 1, left: 0 });
    expect(onInvalidToken).toHaveBeenCalledWith("U_DEAD");
  });

  it("never throws when a member leave fails; archive can still proceed", async () => {
    const { slack, channelId } = await seededChannel();
    await slack.inviteUsers(channelId, ["U1"]);
    slack.leaveChannelAsUser = async () => {
      throw new Error("slack down");
    };

    const summary = await quietlyRemoveMembers(
      { slack, logger, getUserToken: async () => "tok", onInvalidToken: async () => {} },
      channelId,
    );
    expect(summary).toMatchObject({ failed: 1 });
  });

  it("returns without leaving anyone when listing members fails", async () => {
    const { slack, channelId } = await seededChannel();
    slack.listChannelMembers = async () => {
      throw new Error("members failed");
    };
    const leaveSpy = vi.spyOn(slack, "leaveChannelAsUser");

    const summary = await quietlyRemoveMembers(
      { slack, logger, getUserToken: async () => "tok", onInvalidToken: async () => {} },
      channelId,
    );
    expect(summary.members).toBe(0);
    expect(leaveSpy).not.toHaveBeenCalled();
  });
});
