import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateConversationLastNotifiedProfile(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(
      `ALTER TABLE conversations ADD COLUMN last_notified_inference_profile TEXT DEFAULT NULL`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
}
