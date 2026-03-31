import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateDropCallbackTransportColumn(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(
      /*sql*/ `ALTER TABLE oauth_providers DROP COLUMN callback_transport`,
    );
  } catch {
    // Column already dropped or doesn't exist — nothing to do.
  }
}
