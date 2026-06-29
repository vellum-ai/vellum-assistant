import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateOAuthProvidersPingConfig(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(/*sql*/ `ALTER TABLE oauth_providers ADD COLUMN ping_method TEXT`);
  } catch {
    // Column already exists — nothing to do.
  }
  try {
    raw.exec(
      /*sql*/ `ALTER TABLE oauth_providers ADD COLUMN ping_headers TEXT`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
  try {
    raw.exec(/*sql*/ `ALTER TABLE oauth_providers ADD COLUMN ping_body TEXT`);
  } catch {
    // Column already exists — nothing to do.
  }
}
