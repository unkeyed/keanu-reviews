import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client.ts";
import { createTestDb } from "../testDb.ts";
import {
  deleteSlackUserToken,
  getSlackUserTokenRow,
  upsertSlackUserToken,
} from "./slackUserTokens.ts";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  close = () => testDb.client.close();
});

afterEach(() => close());

describe("Slack user tokens", () => {
  it("stores and reads back a token scoped to a workspace", async () => {
    await upsertSlackUserToken(db, {
      slackUserId: "U1",
      slackTeamId: "T1",
      encryptedToken: "cipher-1",
      scopes: "channels:write",
    });
    expect(await getSlackUserTokenRow(db, "T1", "U1")).toEqual({
      encryptedToken: "cipher-1",
      scopes: "channels:write",
    });
    expect(await getSlackUserTokenRow(db, "T1", "U2")).toBeUndefined();
    // A different workspace must not read another team's token.
    expect(await getSlackUserTokenRow(db, "TOTHER", "U1")).toBeUndefined();
  });

  it("overwrites the prior token when the user re-authorizes", async () => {
    await upsertSlackUserToken(db, {
      slackUserId: "U1",
      slackTeamId: "T1",
      encryptedToken: "cipher-old",
      scopes: "channels:write",
    });
    await upsertSlackUserToken(db, {
      slackUserId: "U1",
      slackTeamId: "T1",
      encryptedToken: "cipher-new",
      scopes: "channels:write,chat:write",
    });
    expect(await getSlackUserTokenRow(db, "T1", "U1")).toEqual({
      encryptedToken: "cipher-new",
      scopes: "channels:write,chat:write", // broadened scope on re-authorization
    });
  });

  it("deletes a revoked token", async () => {
    await upsertSlackUserToken(db, {
      slackUserId: "U1",
      slackTeamId: "T1",
      encryptedToken: "cipher-1",
      scopes: "channels:write",
    });
    await deleteSlackUserToken(db, "T1", "U1");
    expect(await getSlackUserTokenRow(db, "T1", "U1")).toBeUndefined();
  });
});
