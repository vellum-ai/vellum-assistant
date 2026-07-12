import type { DrizzleDb } from "../db-connection.js";

/**
 * Delete memory rows whose `scope_id` is not the default workspace scope.
 *
 * Old databases carry `memory_graph_nodes` and `conversation_starters` rows
 * with non-default `scope_id` values (e.g. `subagent:<id>`). Reads query the
 * single workspace memory pool without filtering on `scope_id`, so these rows
 * would surface into recall, consolidation, and starter generation and inflate
 * node counts. Deleting them keeps them invisible, exactly matching the
 * behavior the `scope_id = 'default'` read filters produced.
 *
 * Deleting graph nodes cascades to their edges, triggers, and edits via the
 * `ON DELETE CASCADE` foreign keys (foreign_keys pragma is ON).
 *
 * Idempotent: once the non-default rows are gone, re-running deletes nothing.
 * Each table is wrapped independently so a database missing one of them still
 * purges the other.
 */
export function migrateDeleteNonDefaultMemoryScopes(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `DELETE FROM memory_graph_nodes WHERE scope_id != 'default'`,
    );
  } catch {
    /* table absent */
  }
  try {
    database.run(
      /*sql*/ `DELETE FROM conversation_starters WHERE scope_id != 'default'`,
    );
  } catch {
    /* table absent */
  }
}
