import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Drops the `status` column from the `provider_connections` table.
 *
 * Connection status ("active" | "disabled") has been removed — connections
 * either exist or they don't. Profile status (enabled/disabled) is a separate
 * concept and is untouched by this migration.
 *
 * Idempotent: checks PRAGMA table_info before issuing the DROP so re-running
 * on a database that already lacks the column is a no-op.
 *
 * SQLite 3.35.0+ (Bun bundles a recent SQLite) supports ALTER TABLE DROP COLUMN.
 */
export function migrateDropProviderConnectionStatus(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const columns = raw
    .query(`PRAGMA table_info(provider_connections)`)
    .all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (columnNames.has("status")) {
    raw.exec(`ALTER TABLE provider_connections DROP COLUMN status`);
  }
}
