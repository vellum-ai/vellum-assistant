import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Add llm_call_count column to llm_usage_events so each row records
 * how many actual LLM API calls it represents (an exchange/turn may
 * contain multiple tool-use iterations, each making a separate API call).
 *
 * Nullable INTEGER — existing rows default to NULL and are treated as 1
 * by the aggregation queries via COALESCE.
 */
export function migrateUsageLlmCallCount(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  if (!tableHasColumn(database, "llm_usage_events", "llm_call_count")) {
    raw.exec(
      /*sql*/ `ALTER TABLE llm_usage_events ADD COLUMN llm_call_count INTEGER`,
    );
  }
}
