import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "parent_tool_use_id";
const COLUMN_DEFINITION = "parent_tool_use_id TEXT";

/**
 * Add `parent_tool_use_id` column to the `subagents` table (migration 311).
 *
 * The column is the nullable tool-use id of the `skill_execute` call that
 * spawned the subagent. `SubagentManager` carries it on `SubagentConfig` so
 * the `subagent_spawned` event and the reconcile/detail routes can anchor an
 * inline subagent card to the exact spawn tool call. Persisting it keeps that
 * anchor resolvable once the live state is gone: `rehydrateFromDb()` restores
 * it onto rebuilt children, and both routes read it straight off the row for a
 * subagent the retention sweep has already evicted, so a client reloading
 * after an assistant restart still lands the card on the right tool call.
 *
 * Nullable with no backfill: the id is only known at spawn time and rows
 * written before this column existed have no surviving record of it, so they
 * correctly stay NULL and the field is simply omitted from route responses.
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write doesn't cause a duplicate-column error on
 * the next boot.
 */
export function migrateAddSubagentParentToolUseId(database: DrizzleDb): void {
  if (!tableHasColumn(database, "subagents", COLUMN_NAME)) {
    database.run(`ALTER TABLE subagents ADD COLUMN ${COLUMN_DEFINITION}`);
  }
}
