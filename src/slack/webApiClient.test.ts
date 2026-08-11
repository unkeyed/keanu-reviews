import { describe, expect, it } from "vitest";
import { isSlackChannelAlreadyInState } from "./webApiClient.ts";

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
