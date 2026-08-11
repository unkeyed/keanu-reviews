import { afterEach, describe, expect, it } from "vitest";
import { createDbReadyCheck } from "./readiness.ts";
import { createTestDb } from "./testDb.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("database readiness", () => {
  it("accepts the complete migrated schema", async () => {
    const testDb = await createTestDb();
    cleanups.push(() => testDb.client.close());

    await expect(createDbReadyCheck(testDb.db)()).resolves.toBeUndefined();
  });

  it("rejects a database missing a required table", async () => {
    const testDb = await createTestDb();
    cleanups.push(() => testDb.client.close());
    await testDb.client.exec("drop table identities");

    await expect(createDbReadyCheck(testDb.db)()).rejects.toThrow(/identities/i);
  });
});
