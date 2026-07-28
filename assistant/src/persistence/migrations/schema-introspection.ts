import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Startup still replays the historical table/index bootstrap helpers on every
 * process launch, so migrations need a cheap way to branch on the live schema.
 */
export function tableHasColumn(
  database: DrizzleDb,
  tableName: string,
  columnName: string,
): boolean {
  const raw = getSqliteFrom(database);
  const columns = raw.query(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;

  return columns.some((column) => column.name === columnName);
}

/**
 * True when a base table with the given name exists. Useful for migrations
 * that recreate indexes — `CREATE INDEX IF NOT EXISTS` guards against the
 * index already existing, but still throws "no such table" if the underlying
 * table was already dropped by an earlier migration.
 */
export function tableExists(database: DrizzleDb, tableName: string): boolean {
  const raw = getSqliteFrom(database);
  const row = raw
    .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
  return row != null;
}
