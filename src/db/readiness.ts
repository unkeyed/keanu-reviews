import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "./client.ts";
import * as schema from "./schema.ts";

export type ReadyCheck = () => Promise<void>;

const TABLES = (Object.values(schema) as unknown[]).filter((value): value is PgTable =>
  is(value, PgTable),
);

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
