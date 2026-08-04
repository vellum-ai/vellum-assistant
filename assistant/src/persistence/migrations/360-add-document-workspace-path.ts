import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "workspace_path";
const COLUMN_DEFINITION = "workspace_path TEXT";

/**
 * Add `workspace_path` to `documents` and enforce one document per file.
 *
 * The column holds the workspace-relative path of the markdown file a document
 * is bound to. It is set when a client opens a workspace `.md` file through
 * `POST /v1/documents/for-workspace-file`, which gives the file a document
 * identity so comments, assistant iteration, and PDF export — all keyed off a
 * document id — work on it. Documents that have no file behind them (assistant
 * drafts, client-created surfaces) stay NULL.
 *
 * The unique index is partial (`WHERE workspace_path IS NOT NULL`) so the many
 * NULL rows stay unconstrained while a given file resolves to exactly one
 * document. The find-or-create route depends on that uniqueness for its
 * idempotency.
 *
 * Nullable with no backfill: nothing recorded a file binding before this
 * column existed, so pre-existing rows correctly stay NULL.
 *
 * Idempotent: the column add is guarded with `tableHasColumn` and the index
 * with `IF NOT EXISTS`, so a crash between the two does not break the next
 * boot.
 */
export function migrateAddDocumentWorkspacePath(database: DrizzleDb): void {
  if (!tableHasColumn(database, "documents", COLUMN_NAME)) {
    database.run(`ALTER TABLE documents ADD COLUMN ${COLUMN_DEFINITION}`);
  }

  database.run(/*sql*/ `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_workspace_path
    ON documents(workspace_path)
    WHERE workspace_path IS NOT NULL
  `);
}
