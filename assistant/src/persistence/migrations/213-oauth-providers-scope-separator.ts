import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateOAuthProvidersScopeSeparator(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(
      `ALTER TABLE oauth_providers ADD COLUMN scope_separator TEXT NOT NULL DEFAULT ' '`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
}
