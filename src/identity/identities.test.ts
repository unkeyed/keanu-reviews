import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "#db";
import { createTestDb } from "../db/testDb.ts";
import { findSlackUsersByGithubLogins, upsertIdentity } from "./store.ts";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
});
afterEach(() => close());

describe("findSlackUsersByGithubLogins", () => {
  it("resolves a linked login case-insensitively", async () => {
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "Dave-Hawkins",
      slackUserId: "Udave",
      source: "self-link",
    });
    expect(await findSlackUsersByGithubLogins(db, ["dave-hawkins"])).toEqual(
      new Map([["dave-hawkins", "Udave"]]),
    );
    expect(await findSlackUsersByGithubLogins(db, ["DAVE-HAWKINS"])).toEqual(
      new Map([["dave-hawkins", "Udave"]]),
    );
  });

  it("leaves an unlinked login out", async () => {
    expect(await findSlackUsersByGithubLogins(db, ["nobody"])).toEqual(new Map());
  });

  it("resolves several logins at once, preferring the most recently linked row", async () => {
    await upsertIdentity(db, {
      githubUserId: 1,
      githubLogin: "reused",
      slackUserId: "Uold",
      source: "self-link",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await upsertIdentity(db, {
      githubUserId: 2,
      githubLogin: "Reused",
      slackUserId: "Unew",
      source: "self-link",
    });
    await upsertIdentity(db, {
      githubUserId: 3,
      githubLogin: "bob",
      slackUserId: "Ubob",
      source: "self-link",
    });
    expect(await findSlackUsersByGithubLogins(db, ["reused", "bob", "nobody"])).toEqual(
      new Map([
        ["reused", "Unew"],
        ["bob", "Ubob"],
      ]),
    );
  });
});
