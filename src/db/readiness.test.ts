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

  it("rejects a database that has not applied the lifecycle migration", async () => {
    const testDb = await createTestDb();
    cleanups.push(() => testDb.client.close());
    await testDb.client.exec("drop table pull_request_lifecycle_claims");

    await expect(createDbReadyCheck(testDb.db)()).rejects.toThrow(/pull_request_lifecycle_claims/i);
  });

  it.each(["github_link_confirmations", "oauth_state_nonces"])(
    "rejects a database missing OAuth table %s",
    async (table) => {
      const testDb = await createTestDb();
      cleanups.push(() => testDb.client.close());
      await testDb.client.exec(`drop table ${table}`);

      await expect(createDbReadyCheck(testDb.db)()).rejects.toThrow(new RegExp(table, "i"));
    },
  );
});

describe("database readiness coverage", () => {
  it("rejects a database missing any column of any migrated table", async () => {
    const testDb = await createTestDb();
    cleanups.push(() => testDb.client.close());
    const check = createDbReadyCheck(testDb.db);
    const { rows } = await testDb.client.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' order by table_name, ordinal_position`,
    );
    expect(rows.length).toBeGreaterThan(60);
    expect(rows).toContainEqual({
      table_name: "pull_requests",
      column_name: "merge_comment_posted_at",
    });
    expect(rows).toContainEqual({
      table_name: "slack_user_tokens",
      column_name: "encrypted_token",
    });

    const unprobed: string[] = [];
    for (const { table_name, column_name } of rows) {
      await testDb.client.exec(
        `begin; alter table "${table_name}" drop column "${column_name}" cascade`,
      );
      try {
        await check();
        unprobed.push(`${table_name}.${column_name}`);
      } catch (err) {
        expect(String(err)).toContain(column_name);
      } finally {
        await testDb.client.exec("rollback");
      }
    }
    expect(unprobed).toEqual([]);
    await expect(check()).resolves.toBeUndefined();
  });

  it("rejects a database that has not applied the Slack user token migration", async () => {
    const testDb = await createTestDb();
    cleanups.push(() => testDb.client.close());
    await testDb.client.exec("drop table slack_user_tokens");

    await expect(createDbReadyCheck(testDb.db)()).rejects.toThrow(/slack_user_tokens/i);
  });
});
