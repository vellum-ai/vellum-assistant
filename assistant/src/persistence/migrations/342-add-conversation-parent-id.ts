import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "parent_conversation_id";
const COLUMN_DEFINITION = "parent_conversation_id TEXT";

/**
 * Add `parent_conversation_id` column to the `conversations` table.
 *
 * The column is a nullable, free-form id of the conversation that spawned
 * this one (subagent spawns stamp their parent's conversation id), enabling
 * telemetry to attribute a subagent's LLM usage to the user turn that
 * triggered it. It is intentionally NOT a foreign key: usage events flush on
 * a watermark that can trail the parent conversation's lifetime, so the
 * linkage must survive parent deletion without cascade churn.
 *
 * No backfill is needed — all existing rows default to NULL (not spawned by
 * another conversation), which is correct for any pre-migration conversation.
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write doesn't cause a duplicate-column error on
 * the next boot. The index uses `IF NOT EXISTS` for the same reason.
 */
export function migrateAddConversationParentId(database: DrizzleDb): void {
  if (!tableHasColumn(database, "conversations", COLUMN_NAME)) {
    database.run(`ALTER TABLE conversations ADD COLUMN ${COLUMN_DEFINITION}`);
  }
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_conversations_parent_conversation_id ON conversations(parent_conversation_id)`,
  );
}
