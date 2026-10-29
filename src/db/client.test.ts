import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "./client.ts";

// PGlite cannot stand in for postgres.js, so this runs only against a real server.
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(databaseUrl)("createDb against a real Postgres", () => {
  it("cancels a statement that runs past the timeout instead of hanging", async () => {
    const { db, close } = createDb(databaseUrl as string);
    try {
      await expect(db.execute(sql`select pg_sleep(31)`)).rejects.toMatchObject({
        cause: expect.objectContaining({ code: "57014" }),
      });
    } finally {
      await close();
    }
  }, 40_000);
});
