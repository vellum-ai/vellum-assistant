import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateOAuthProvidersDisplayMetadata(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  const columns = [
    "display_name TEXT",
    "description TEXT",
    "dashboard_url TEXT",
    "client_id_placeholder TEXT",
    "requires_client_secret INTEGER NOT NULL DEFAULT 1",
  ];
  for (const col of columns) {
    try {
      raw.exec(`ALTER TABLE oauth_providers ADD COLUMN ${col}`);
    } catch {
      // Column already exists — nothing to do.
    }
  }
}
