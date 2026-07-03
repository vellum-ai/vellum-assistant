import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateOAuthProvidersRevoke(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const columns = ["revoke_url TEXT", "revoke_body_template TEXT"];
  for (const col of columns) {
    try {
      raw.exec(`ALTER TABLE oauth_providers ADD COLUMN ${col}`);
    } catch {
      // Column already exists — nothing to do.
    }
  }
}
