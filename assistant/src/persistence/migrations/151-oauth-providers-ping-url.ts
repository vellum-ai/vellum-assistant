import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateOAuthProvidersPingUrl(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(/*sql*/ `ALTER TABLE oauth_providers ADD COLUMN ping_url TEXT`);
  } catch {
    // Column already exists — nothing to do.
  }
}
