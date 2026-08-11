import { describe, expect, it, vi } from "vitest";
import { isSlackChannelAlreadyInState, lookupSlackUserByEmail } from "./webApiClient.ts";

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
});
