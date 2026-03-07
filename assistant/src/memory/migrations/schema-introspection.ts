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
