import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_document_conversations_v1";

/**
 * Create the document_conversations junction table.
 *
 * Tracks which conversations each document is associated with. A document may
 * appear in multiple conversations (e.g. opened from search, linked by the
 * assistant, etc.), so the relationship is many-to-many.
 *
 * The FK on surface_id cascades deletes from documents — when a document is
 * removed, all its conversation associations are cleaned up automatically.
 *
 * There is intentionally NO FK to the conversations table. Conversation IDs may
 * be synthetic or pre-resolved UUIDs that don't yet exist in the conversations
 * table at insertion time. This means orphaned rows can accumulate when
 * conversations are deleted. This is acceptable — the rows are tiny (two strings
 * + timestamp) and the composite PK prevents unbounded growth per document. If
 * cleanup becomes a concern, add a periodic sweep or hook into the conversation
 * deletion path in memory/job-handlers/cleanup.ts.
 *
 * The migration also backfills from the existing documents.conversation_id column
 * so that pre-existing document–conversation relationships are preserved.
 */
export function migrateCreateDocumentConversations(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS document_conversations (
        surface_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        PRIMARY KEY (surface_id, conversation_id),
        FOREIGN KEY (surface_id) REFERENCES documents(surface_id) ON DELETE CASCADE
      )
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_doc_conv_conversation_id
      ON document_conversations(conversation_id)
    `);

    // Backfill: seed junction table from existing documents.conversation_id
    raw.exec(/*sql*/ `
      INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at)
      SELECT surface_id, conversation_id, created_at
      FROM documents
    `);
  });
}
