import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "./client.ts";
import * as schema from "./schema.ts";

export type ReadyCheck = () => Promise<void>;

/** Every table the schema declares, so a new table or column is probed without a list to keep in sync. */
const TABLES = (Object.values(schema) as unknown[]).filter((value): value is PgTable =>
  is(value, PgTable),
);

/**
 * Build a readiness probe that checks both database reachability and every
 * table and column the schema declares. `limit 0` keeps the probe cheap while
 * PostgreSQL still resolves the full schema at parse time.
 */
export function createDbReadyCheck(db: Db): ReadyCheck {
  const probes = TABLES.map(
    (table) =>
      sql`(select row(${sql.join(Object.values(getTableColumns(table)), sql`, `)})::text from ${table} limit 0) as ${sql.identifier(getTableName(table))}`,
  );
  const probe = sql`select ${sql.join(probes, sql`, `)}`;
  return async () => {
    await db.execute(probe);
  };
}
