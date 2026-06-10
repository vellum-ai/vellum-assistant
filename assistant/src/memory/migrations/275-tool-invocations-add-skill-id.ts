import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Add a nullable `skill_id` column to `tool_invocations`.
 *
 * Records which skill's `skill_execute` dispatch triggered the tool call so
 * the `tool_execution` telemetry event can attribute skill-routed
 * invocations. `NULL` for direct (non-skill) tool calls and for rows
 * persisted before this migration ran.
 *
 * Idempotent — re-running is a no-op once the column exists. Pure DDL with a
 * PRAGMA guard, no registry entry needed (matches the 273 pattern).
 */
export function migrateToolInvocationsSkillId(database: DrizzleDb): void {
  if (tableHasColumn(database, "tool_invocations", "skill_id")) {
    return;
  }
  database.run(`ALTER TABLE tool_invocations ADD COLUMN skill_id TEXT`);
}
