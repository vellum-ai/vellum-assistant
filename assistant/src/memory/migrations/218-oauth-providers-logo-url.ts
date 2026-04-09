import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateOAuthProvidersLogoUrl(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(`ALTER TABLE oauth_providers ADD COLUMN logo_url TEXT`);
  } catch {
    // Column already exists — nothing to do.
  }
}
