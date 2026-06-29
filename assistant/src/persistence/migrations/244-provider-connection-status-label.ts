import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Adds `status` (NOT NULL DEFAULT 'active') and `label` (nullable) columns
 * to the `provider_connections` table.
 *
 * Idempotent: reads PRAGMA table_info before each ALTER so re-running on a
 * database that already has the columns is a no-op.
 */
export function migrateProviderConnectionStatusLabel(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const columns = raw
    .query(`PRAGMA table_info(provider_connections)`)
    .all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("status")) {
    raw.exec(
      `ALTER TABLE provider_connections ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
    );
  }

  if (!columnNames.has("label")) {
    raw.exec(`ALTER TABLE provider_connections ADD COLUMN label TEXT`);
  }
}
