import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "conversation_type";
const COLUMN_DEFINITION = "conversation_type TEXT";

/**
 * Add `conversation_type` column to the `llm_usage_events` table and
 * backfill it from `conversations` for existing rows.
 *
 * The column captures the parent conversation's `conversation_type`
 * (`"standard"` / `"background"` / `"scheduled"`) at the moment the usage
 * event is RECORDED. The telemetry reporter previously derived the type
 * exclusively via a flush-time LEFT JOIN to `conversations`, but usage rows
 * outlive conversation rows — memory-retrospective forks are GC'd once a
 * newer run supersedes them (or deleted immediately on wake failure), and
 * users can delete conversations — so any row flushed after its parent
 * conversation's deletion reported a null `conversation_type` despite
 * carrying a `conversation_id`.
 *
 * The backfill stamps every existing row whose parent conversation still
 * exists, so usage rows pending flush at upgrade time (delayed or offline
 * telemetry) keep their type even if the parent conversation is deleted
 * before the next successful flush. Rows whose parents are already gone
 * stay NULL — their type is unrecoverable. The telemetry read path
 * (`queryUnreportedUsageEvents`) COALESCEs the stored value with the JOIN
 * as a final fallback.
 *
 * Idempotent: the ALTER is guarded with `tableHasColumn` so a crash between
 * the `ALTER TABLE` and the checkpoint write doesn't cause a
 * duplicate-column error on the next boot, and the backfill only fills NULL
 * values so a re-run never overwrites record-time stamps.
 */
export function migrateAddLlmUsageConversationType(database: DrizzleDb): void {
  if (!tableHasColumn(database, "llm_usage_events", COLUMN_NAME)) {
    database.run(
      `ALTER TABLE llm_usage_events ADD COLUMN ${COLUMN_DEFINITION}`,
    );
  }
  database.run(
    `UPDATE llm_usage_events
     SET conversation_type = (
       SELECT c.conversation_type FROM conversations AS c
       WHERE c.id = llm_usage_events.conversation_id
     )
     WHERE conversation_id IS NOT NULL
       AND conversation_type IS NULL`,
  );
}
