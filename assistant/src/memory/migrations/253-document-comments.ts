import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Create the `document_comments` table for inline and document-level comments.
 *
 * Supports threaded replies via `parent_comment_id` and resolution tracking
 * via `status`, `resolved_by`, and `resolved_at`. The FK on `surface_id`
 * cascades deletes from `documents` — when a document is removed, all its
 * comments are cleaned up automatically.
 *
 * Idempotent — re-running is a no-op once the table and indices exist.
 */
export function migrateCreateDocumentComments(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS document_comments (
      id TEXT PRIMARY KEY,
      surface_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      anchor_start INTEGER,
      anchor_end INTEGER,
      anchor_text TEXT,
      parent_comment_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      resolved_by TEXT,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (surface_id) REFERENCES documents(surface_id) ON DELETE CASCADE,
      FOREIGN KEY (parent_comment_id) REFERENCES document_comments(id) ON DELETE CASCADE
    )
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_document_comments_surface
    ON document_comments(surface_id)
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_document_comments_parent
    ON document_comments(parent_comment_id)
  `);
}
