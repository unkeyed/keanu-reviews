import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client.ts";
import { createTestDb } from "../testDb.ts";
import { findByGithubLogin, upsertIdentity } from "./identities.ts";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestDb();
  db = t.db;
  close = () => t.client.close();
});
afterEach(() => close());

describe("findByGithubLogin", () => {
  it("resolves a linked login case-insensitively", async () => {
    await upsertIdentity(db, {
      githubUserId: 7,
      githubLogin: "Dave-Hawkins",
      slackUserId: "Udave",
      source: "self-link",
    });
    expect((await findByGithubLogin(db, "dave-hawkins"))?.slackUserId).toBe("Udave");
    expect((await findByGithubLogin(db, "DAVE-HAWKINS"))?.slackUserId).toBe("Udave");
  });

  it("returns undefined for an unlinked login", async () => {
    expect(await findByGithubLogin(db, "nobody")).toBeUndefined();
  });
});
