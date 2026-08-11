import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "./client.ts";
import * as schema from "./schema.ts";

/**
 * In-memory Postgres (PGlite) for offline repository tests. Applies the generated
 * init migration so tests exercise the real schema, not a hand-rolled copy.
 *
 * The live PlanetScale-migration gate in the Verification Contract still requires
 * a real DATABASE_URL — this harness covers repository behavior offline only.
 */
const migrationDir = fileURLToPath(new URL("./migrations", import.meta.url));

export async function createTestDb(): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;

  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const ddl = readFileSync(`${migrationDir}/${file}`, "utf8");
    // drizzle emits statements separated by a breakpoint marker.
    for (const stmt of ddl.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }

  return { db, client };
}
