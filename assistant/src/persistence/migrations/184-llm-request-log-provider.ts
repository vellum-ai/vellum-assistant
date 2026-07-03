import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateLlmRequestLogProvider(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  try {
    raw.exec(/*sql*/ `ALTER TABLE llm_request_logs ADD COLUMN provider TEXT`);
  } catch {
    // Column already exists — nothing to do.
  }
}
