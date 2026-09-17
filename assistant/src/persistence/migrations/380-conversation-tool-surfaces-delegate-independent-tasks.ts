import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const TABLE_NAME = "conversation_tool_surfaces";
const COLUMN_NAME = "delegate_independent_tasks";
const COLUMN_DEFINITION = "delegate_independent_tasks INTEGER";

/**
 * Add `delegate_independent_tasks` to `conversation_tool_surfaces`: whether
 * the system prompt of the turn that recorded the surface rendered the
 * parallel-delegation section (`01-parallel-tasks`). The prompt derives that
 * section from the same resolved tool surface, so a fork wake replaying the
 * surface needs the rendered state too: the section sits in the system
 * prompt, the second tier of the provider cache prefix, and a fork that
 * derives it from its own restricted scope renders it off where the source
 * rendered it on, missing the source's cached prefix from that byte on.
 *
 * Nullable with no backfill: a row written before the column existed reads
 * null and the fork derives the section for itself, exactly as it did before
 * the column; the next live turn records the state.
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write doesn't cause a duplicate-column error on
 * the next boot. A missing table is not swallowed: the registry declares the
 * dependency on the table's own step, so this one is deferred rather than
 * checkpointed as done against no table.
 */
export function migrateConversationToolSurfacesDelegateIndependentTasks(
  database: DrizzleDb,
): void {
  if (!tableHasColumn(database, TABLE_NAME, COLUMN_NAME)) {
    database.run(`ALTER TABLE ${TABLE_NAME} ADD COLUMN ${COLUMN_DEFINITION}`);
  }
}
