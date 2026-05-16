import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Adds `base_url` (nullable) and `models` (nullable, JSON-encoded array of
 * model identifiers) columns to the `provider_connections` table.
 *
 * Required by openai-compatible connections, which carry a user-supplied
 * endpoint and model list per row instead of inheriting them from the catalog.
 * Idempotent — re-running is a no-op once the columns exist.
 */
export function migrateProviderConnectionBaseUrlAndModels(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const columns = raw
    .query(`PRAGMA table_info(provider_connections)`)
    .all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("base_url")) {
    raw.exec(`ALTER TABLE provider_connections ADD COLUMN base_url TEXT`);
  }

  if (!columnNames.has("models")) {
    raw.exec(`ALTER TABLE provider_connections ADD COLUMN models TEXT`);
  }
}
