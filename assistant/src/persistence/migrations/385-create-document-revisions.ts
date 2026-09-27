import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Create `document_revisions`: snapshots of a document's title and body as
 * they stood at a given revision, taken just before a write replaces them.
 *
 * `(surface_id, revision)` is the primary key, so a state is stored at most
 * once. The FK cascades from `documents`, so deleting a document drops its
 * history.
 *
 * Idempotent: `IF NOT EXISTS` makes a re-run a no-op.
 */
export function migrateCreateDocumentRevisions(database: DrizzleDb): void {
  getSqliteFrom(database).exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS document_revisions (
      surface_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      author TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (surface_id, revision),
      FOREIGN KEY (surface_id) REFERENCES documents(surface_id) ON DELETE CASCADE
    )
  `);
}
