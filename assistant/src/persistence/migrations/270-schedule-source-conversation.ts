import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateScheduleSourceConversation(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(
      `ALTER TABLE cron_jobs ADD COLUMN created_from_conversation_id TEXT`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
}
