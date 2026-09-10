import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "budget_stop_reason";
const COLUMN_DEFINITION = "budget_stop_reason TEXT";

/**
 * Add `budget_stop_reason` to the `subagents` table (migration 311).
 *
 * A child stopped at a `maxRuntimeMs` or `maxToolCalls` ceiling records status
 * `aborted`, which is indistinguishable on the row from a run the user
 * cancelled. The repeat-spawn guard treats `aborted` as a dead end whose retry
 * is the right move, so an objective that burns its ceiling every time read as
 * a fresh retry forever and never tripped the guard, however much it cost. This
 * column carries which budget stopped the run, letting the guard count those
 * rows while leaving genuine cancellations alone.
 *
 * Nullable with no backfill: rows written before this column existed kept no
 * record of why they aborted, so they correctly stay NULL and are counted as
 * cancellations, which is the conservative reading for a guard that only
 * advises.
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write doesn't cause a duplicate-column error on
 * the next boot.
 */
export function migrateAddSubagentBudgetStopReason(database: DrizzleDb): void {
  if (!tableHasColumn(database, "subagents", COLUMN_NAME)) {
    database.run(`ALTER TABLE subagents ADD COLUMN ${COLUMN_DEFINITION}`);
  }
}
