import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "./client.ts";
import { claimMessageEffect } from "./repositories/messages.ts";
import * as schema from "./schema.ts";

const migrationDirectory = fileURLToPath(new URL("./migrations", import.meta.url));
const clients: PGlite[] = [];

async function applyMigration(client: PGlite, fileName: string): Promise<void> {
  const ddl = readFileSync(`${migrationDirectory}/${fileName}`, "utf8");
  for (const statement of ddl.split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) await client.exec(sql);
  }
}

function legacyClientMessageId(naturalKey: string): string {
  const hash = createHash("md5").update(naturalKey).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20),
  ].join("-");
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("incremental legacy-schema upgrade", () => {
  it("consolidates already-attempted messages and repository-rename PR history", async () => {
    const client = new PGlite();
    clients.push(client);
    await applyMigration(client, "0000_init.sql");

    await client.exec(`
      INSERT INTO "pull_requests" (
        "id", "repo_full_name", "number", "github_pr_id", "channel_id",
        "current_state", "head_sha", "root_message_ts", "created_at", "updated_at"
      ) VALUES
        (
          'legacy-canonical', 'old-owner/repo', 7, 9001, 'C-ESTABLISHED',
          'pr', 'old-sha', '100.001', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
        ),
        (
          'legacy-fresh', 'new-owner/repo', 7, 9001, NULL,
          'merged', 'new-sha', NULL, '2026-02-01T00:00:00Z', '2026-02-02T00:00:00Z'
        );

      INSERT INTO "messages" (
        "id", "pr_id", "github_event_ref", "slack_ts", "kind", "created_at"
      ) VALUES
        ('null-placeholder', 'legacy-canonical', NULL, '-', 'lifecycle', '2026-01-01T00:00:00Z'),
        ('null-real', 'legacy-canonical', NULL, '101.001', 'lifecycle', '2026-01-01T00:01:00Z'),
        ('placeholder-only', 'legacy-fresh', 'check-1', '-', 'ci', '2026-01-01T00:02:00Z'),
        ('review-real', 'legacy-canonical', 'review-1', '102.001', 'review', '2026-01-01T00:03:00Z'),
        ('review-placeholder', 'legacy-fresh', 'review-1', '-', 'review', '2026-01-01T00:04:00Z'),
        ('fresh-unique', 'legacy-fresh', 'issue-1', '103.001', 'issue', '2026-01-01T00:05:00Z');

      INSERT INTO "reminders" (
        "id", "pr_id", "reviewer_github_id", "due_at", "status", "created_at"
      ) VALUES
        (
          'legacy-canonical::101', 'legacy-canonical', 101,
          '2026-01-01T12:00:00Z', 'sent', '2026-01-01T00:00:00Z'
        ),
        (
          'legacy-fresh::101', 'legacy-fresh', 101,
          '2026-01-02T12:00:00Z', 'pending', '2026-01-02T00:00:00Z'
        ),
        (
          'legacy-fresh::202', 'legacy-fresh', 202,
          '2026-01-03T12:00:00Z', 'pending', '2026-01-03T00:00:00Z'
        );
    `);

    await applyMigration(client, "0001_durable_leases.sql");
    await applyMigration(client, "0002_cooing_nehzno.sql");

    const afterMessageUpgrade = await client.query<{
      id: string;
      natural_key: string;
      client_msg_id: string;
      slack_ts: string | null;
      status: string;
    }>(`
      SELECT "id", "natural_key", "client_msg_id", "slack_ts", "status"::text
      FROM "messages"
      ORDER BY "id"
    `);
    expect(afterMessageUpgrade.rows.map(({ id }) => id)).not.toContain("null-placeholder");
    expect(afterMessageUpgrade.rows.map(({ id }) => id)).toContain("null-real");
    expect(afterMessageUpgrade.rows.every(({ status }) => status === "sent")).toBe(true);
    expect(
      afterMessageUpgrade.rows.find(({ id }) => id === "placeholder-only")?.slack_ts,
    ).toBeNull();
    for (const message of afterMessageUpgrade.rows) {
      expect(message.client_msg_id).toBe(legacyClientMessageId(message.natural_key));
      expect(message.client_msg_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }

    await applyMigration(client, "0003_naive_bloodaxe.sql");

    const upgradedPr = await client.query<{
      id: string;
      repo_full_name: string;
      current_state: string;
      head_sha: string;
      channel_id: string;
      root_message_ts: string;
      updated_at: Date;
    }>(`
      SELECT
        "id", "repo_full_name", "current_state"::text, "head_sha", "channel_id",
        "root_message_ts", "updated_at"
      FROM "pull_requests"
      WHERE "github_pr_id" = 9001
    `);
    expect(upgradedPr.rows).toHaveLength(1);
    expect(upgradedPr.rows[0]).toMatchObject({
      id: "legacy-canonical",
      repo_full_name: "new-owner/repo",
      current_state: "merged",
      head_sha: "new-sha",
      channel_id: "C-ESTABLISHED",
      root_message_ts: "100.001",
    });
    expect(new Date(upgradedPr.rows[0]?.updated_at as Date).toISOString()).toBe(
      "2026-02-02T00:00:00.000Z",
    );

    const messages = await client.query<{
      id: string;
      pr_id: string;
      natural_key: string;
      client_msg_id: string;
      slack_ts: string | null;
      status: string;
    }>(`
      SELECT "id", "pr_id", "natural_key", "client_msg_id", "slack_ts", "status"::text
      FROM "messages"
      ORDER BY "id"
    `);
    expect(messages.rows).toHaveLength(4);
    expect(messages.rows.every(({ pr_id }) => pr_id === "legacy-canonical")).toBe(true);
    expect(messages.rows.every(({ status }) => status === "sent")).toBe(true);
    expect(new Set(messages.rows.map(({ natural_key }) => natural_key)).size).toBe(
      messages.rows.length,
    );
    for (const message of messages.rows) {
      expect(message.client_msg_id).toBe(legacyClientMessageId(message.natural_key));
    }
    expect(messages.rows.find(({ id }) => id === "review-real")?.slack_ts).toBe("102.001");
    expect(messages.rows.map(({ id }) => id)).not.toContain("review-placeholder");

    const reminders = await client.query<{
      id: string;
      pr_id: string;
      reviewer_github_id: number;
      status: string;
    }>(`
      SELECT "id", "pr_id", "reviewer_github_id", "status"::text
      FROM "reminders"
      ORDER BY "reviewer_github_id"
    `);
    expect(reminders.rows).toEqual([
      {
        id: "legacy-canonical::101",
        pr_id: "legacy-canonical",
        reviewer_github_id: 101,
        status: "pending",
      },
      {
        id: "legacy-canonical::202",
        pr_id: "legacy-canonical",
        reviewer_github_id: 202,
        status: "pending",
      },
    ]);

    await applyMigration(client, "0004_cool_bulldozer.sql");
    const reminderVersions = await client.query<{
      due_at: Date;
      available_at: Date;
      source_updated_at: Date;
      created_at: Date;
      generation: number;
      attempts: number;
    }>(`
      SELECT "due_at", "available_at", "source_updated_at", "created_at", "generation", "attempts"
      FROM "reminders"
      ORDER BY "reviewer_github_id"
    `);
    expect(reminderVersions.rows).toHaveLength(2);
    for (const reminder of reminderVersions.rows) {
      expect(new Date(reminder.available_at).toISOString()).toBe(
        new Date(reminder.due_at).toISOString(),
      );
      expect(new Date(reminder.source_updated_at).toISOString()).toBe(
        new Date(reminder.created_at).toISOString(),
      );
      expect(reminder.generation).toBe(1);
      expect(reminder.attempts).toBe(0);
    }

    const db = drizzle(client, { schema }) as unknown as Db;
    await expect(
      claimMessageEffect(db, {
        prId: "legacy-canonical",
        kind: "ci",
        githubEventRef: "check-1",
      }),
    ).resolves.toBeUndefined();

    await expect(
      client.exec(`
        INSERT INTO "pull_requests" (
          "id", "repo_full_name", "number", "github_pr_id", "current_state"
        ) VALUES ('duplicate-id', 'another/repo', 99, 9001, 'pr')
      `),
    ).rejects.toThrow(/pr_github_id_unique|duplicate key|unique/i);
  });
});
