import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateConversationInferenceProfileSession(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(
      `ALTER TABLE conversations ADD COLUMN inference_profile_session_id TEXT DEFAULT NULL`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
  try {
    raw.exec(
      `ALTER TABLE conversations ADD COLUMN inference_profile_expires_at INTEGER DEFAULT NULL`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_conversations_inference_profile_expires_at ON conversations (inference_profile_expires_at) WHERE inference_profile_expires_at IS NOT NULL`,
  );
}
