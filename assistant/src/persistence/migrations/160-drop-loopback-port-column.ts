import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateDropLoopbackPortColumn(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(/*sql*/ `ALTER TABLE oauth_providers DROP COLUMN loopback_port`);
  } catch {
    // Column already dropped or doesn't exist — nothing to do.
  }
}
