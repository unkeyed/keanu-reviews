import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "#db";
import { createTestDb } from "../db/testDb.ts";
import {
  deleteSlackUserToken,
  getSlackUserTokenRow,
  getSlackUserTokenRows,
  upsertSlackUserToken,
} from "./store.ts";

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
      scopes: "channels:write,chat:write",
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

  it("reads several users' tokens in one call, scoped to the workspace", async () => {
    for (const [slackUserId, slackTeamId] of [
      ["U1", "T1"],
      ["U2", "T1"],
      ["U3", "TOTHER"],
    ] as const) {
      await upsertSlackUserToken(db, {
        slackUserId,
        slackTeamId,
        encryptedToken: `cipher-${slackUserId}`,
        scopes: "channels:write",
      });
    }
    expect(await getSlackUserTokenRows(db, "T1", ["U1", "U2", "U3", "U4"])).toEqual(
      new Map([
        ["U1", { encryptedToken: "cipher-U1", scopes: "channels:write" }],
        ["U2", { encryptedToken: "cipher-U2", scopes: "channels:write" }],
      ]),
    );
    expect(await getSlackUserTokenRows(db, "T1", [])).toEqual(new Map());
  });
});
