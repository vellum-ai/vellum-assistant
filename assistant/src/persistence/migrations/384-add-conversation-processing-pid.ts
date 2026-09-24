import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "processing_pid";

/**
 * Add `processing_pid` to `conversations`: the pid of the process whose turn
 * set `processing_started_at`. It is what lets a second process tell a live
 * claim from a stale one (see `persistence/processing-claim.ts`).
 *
 * No backfill: a row holding a `processing_started_at` with no pid is treated
 * as a legacy claim, which the next acquirer takes over.
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write does not raise a duplicate-column error on
 * the next boot.
 */
export function migrateAddConversationProcessingPid(database: DrizzleDb): void {
  if (tableHasColumn(database, "conversations", COLUMN_NAME)) {
    return;
  }
  database.run(`ALTER TABLE conversations ADD COLUMN ${COLUMN_NAME} INTEGER`);
}
