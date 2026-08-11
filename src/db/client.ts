import type { PgDatabase } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

/**
 * Driver-agnostic database handle. Production uses postgres.js against
 * PlanetScale Postgres; tests use PGlite (see `testDb.ts`). Repositories accept
 * this type so the same code runs in both.
 */
// biome-ignore lint/suspicious/noExplicitAny: broad base type so postgres-js and pglite drizzle instances are both assignable.
export type Db = PgDatabase<any, typeof schema>;

export function createDb(databaseUrl: string): { db: Db; close: () => Promise<void> } {
  const sql = postgres(databaseUrl, { max: 10 });
  const db = drizzle(sql, { schema }) as unknown as Db;
  return { db, close: () => sql.end({ timeout: 5 }) };
}
