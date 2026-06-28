import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "seq";
const COLUMN_DEFINITION = "seq INTEGER";

/**
 * Add the `seq` column to the `conversations` table.
 *
 * The column holds the highest stream `seq` whose content is durably persisted
 * to the conversation's message rows: seeded with the global high-water seq
 * when the row is inserted and advanced on each persistence flush. It is the
 * durable snapshot↔stream alignment baseline returned by `/messages` — a
 * client aligns its snapshot with the `/events` stream by applying only events
 * with a higher `seq`.
 *
 * Nullable: NULL means the conversation was created before any stream activity
 * (global seq was 0) or predates this column, in which case the client
 * cold-starts.
 *
 * No backfill is needed — existing rows default to NULL, which correctly maps
 * to "no recorded baseline, cold-start".
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write doesn't cause a duplicate-column error on
 * the next boot.
 */
export function migrateAddConversationCreationSeq(database: DrizzleDb): void {
  if (tableHasColumn(database, "conversations", COLUMN_NAME)) {
    return;
  }
  database.run(`ALTER TABLE conversations ADD COLUMN ${COLUMN_DEFINITION}`);
}
