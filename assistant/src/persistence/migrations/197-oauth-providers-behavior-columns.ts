import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateOAuthProvidersBehaviorColumns(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  const columns = [
    "loopback_port INTEGER",
    "injection_templates TEXT",
    "setup_skill_id TEXT",
    "app_type TEXT",
    "setup_notes TEXT",
    "identity_url TEXT",
    "identity_method TEXT",
    "identity_headers TEXT",
    "identity_body TEXT",
    "identity_response_paths TEXT",
    "identity_format TEXT",
    "identity_ok_field TEXT",
  ];
  for (const col of columns) {
    try {
      raw.exec(`ALTER TABLE oauth_providers ADD COLUMN ${col}`);
    } catch {
      // Column already exists — nothing to do.
    }
  }
}
