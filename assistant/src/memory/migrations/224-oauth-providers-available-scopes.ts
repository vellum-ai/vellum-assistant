import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateOAuthProvidersAvailableScopes(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(`ALTER TABLE oauth_providers ADD COLUMN available_scopes TEXT`);
  } catch {
    // Column already exists — nothing to do.
  }
}
