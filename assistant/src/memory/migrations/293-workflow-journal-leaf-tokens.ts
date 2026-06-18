import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add nullable `input_tokens` / `output_tokens` columns to `workflow_journal`.
 *
 * Persists per-leaf token usage so the journal route can attribute usage to each
 * leaf. The client then computes run-level token metrics from the per-leaf sum
 * (a single source of truth), counting each leaf exactly once regardless of
 * whether its usage arrives via a live `leaf_finished` event or a journal
 * backfill — which avoids the undercount that arose when a mid-run journal
 * aggregate counted a leaf the journal could not itself attribute.
 *
 * Nullable — legacy rows and non-completed leaves (failures, nested
 * `workflow`-kind entries) stay NULL and contribute zero to the sum.
 *
 * Idempotent — each ALTER is wrapped so a re-run (column already present) is a
 * no-op.
 */
export function migrateWorkflowJournalLeafTokens(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(`ALTER TABLE workflow_journal ADD COLUMN input_tokens INTEGER`);
  } catch {
    /* Column already exists */
  }
  try {
    raw.exec(`ALTER TABLE workflow_journal ADD COLUMN output_tokens INTEGER`);
  } catch {
    /* Column already exists */
  }
}
