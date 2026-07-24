import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "conversation_source";
const COLUMN_DEFINITION = "conversation_source TEXT";

/**
 * Add `conversation_source` column to the `llm_usage_events` table and
 * backfill it from `conversations` for existing rows.
 *
 * The column captures the parent conversation's `source` (`"user"` /
 * `"subagent"` / `"schedule"` / `"memory-retrospective"` / ...) at the moment
 * the usage event is RECORDED. The telemetry reporter derives the source via a
 * flush-time LEFT JOIN to `conversations`, but usage rows outlive conversation
 * rows — memory-retrospective forks are GC'd once a newer run supersedes them
 * (or deleted immediately on wake failure), and users can delete conversations
 * — so any row flushed after its parent conversation's deletion would report a
 * null `conversation_source` despite carrying a `conversation_id`. This mirrors
 * the record-time stamping migration 353 added for `conversation_type`.
 *
 * The backfill stamps every existing row whose parent conversation still
 * exists, so usage rows pending flush at upgrade time (delayed or offline
 * telemetry) keep their source even if the parent conversation is deleted
 * before the next successful flush. Rows whose parents are already gone stay
 * NULL — their source is unrecoverable. The telemetry read path
 * (`queryUnreportedUsageEvents`) COALESCEs the stored value with the JOIN as a
 * final fallback.
 *
 * Idempotent: the ALTER is guarded with `tableHasColumn` so a crash between
 * the `ALTER TABLE` and the checkpoint write doesn't cause a duplicate-column
 * error on the next boot, and the backfill only fills NULL values so a re-run
 * never overwrites record-time stamps.
 */
export function migrateAddLlmUsageConversationSource(
  database: DrizzleDb,
): void {
  if (!tableHasColumn(database, "llm_usage_events", COLUMN_NAME)) {
    database.run(
      `ALTER TABLE llm_usage_events ADD COLUMN ${COLUMN_DEFINITION}`,
    );
  }
  database.run(
    `UPDATE llm_usage_events
     SET conversation_source = (
       SELECT c.source FROM conversations AS c
       WHERE c.id = llm_usage_events.conversation_id
     )
     WHERE conversation_id IS NOT NULL
       AND conversation_source IS NULL`,
  );
}
