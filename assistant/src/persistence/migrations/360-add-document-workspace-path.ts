import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "workspace_path";
const COLUMN_DEFINITION = "workspace_path TEXT";

/**
 * Add `workspace_path` to `documents` and enforce one document per file.
 *
 * The column and its partial unique index are unused by the daemon: no code
 * reads or writes them. Some rows carry a non-NULL path; new rows stay NULL.
 * The migration stays in the chain because migrations are append-only, and the
 * drizzle model in `schema/documents.ts` carries the column so it keeps
 * describing the physical table.
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
