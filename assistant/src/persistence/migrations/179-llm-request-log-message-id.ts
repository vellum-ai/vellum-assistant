import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateLlmRequestLogMessageId(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(/*sql*/ `ALTER TABLE llm_request_logs ADD COLUMN message_id TEXT`);
  } catch {
    // Column already exists — nothing to do.
  }

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_llm_request_logs_message_id
    ON llm_request_logs(message_id)
  `);
}
