import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateOAuthProvidersLoopbackHost(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(/*sql*/ `ALTER TABLE oauth_providers ADD COLUMN loopback_host TEXT`);
  } catch {
    // Column already exists — nothing to do.
  }
}
