import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "revision";
const COLUMN_DEFINITION = "revision INTEGER NOT NULL DEFAULT 0";

/**
 * Add `revision` to `documents`: a counter every write bumps by one, which
 * lets a client make its save conditional on the revision it last saw.
 *
 * Existing rows start at 0 with no backfill; their next write moves them to 1.
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write does not raise a duplicate-column error on
 * the next boot.
 */
export function migrateAddDocumentRevision(database: DrizzleDb): void {
  if (!tableHasColumn(database, "documents", COLUMN_NAME)) {
    database.run(`ALTER TABLE documents ADD COLUMN ${COLUMN_DEFINITION}`);
  }
}
