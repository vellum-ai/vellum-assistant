/**
 * Runtime migration for display_order and is_pinned columns on the
 * conversations table. Extracted into its own module to avoid circular
 * dependencies between conversation-crud.ts and conversation-queries.ts
 * (which needs the migration to run before ORDER BY display_order).
 */

import { getLogger } from "../util/logger.js";
import { rawRun } from "./db.js";

const log = getLogger("conversation-store");

function isDuplicateColumnError(err: unknown): boolean {
  return err instanceof Error && /duplicate column name:/i.test(err.message);
}

function ensureDisplayOrderColumns(): void {
  try {
    rawRun("ALTER TABLE conversations ADD COLUMN display_order INTEGER");
  } catch (err) {
    if (!isDuplicateColumnError(err)) {
      log.error({ err }, "Failed to add display_order column");
      throw err;
    }
  }
  try {
    rawRun("ALTER TABLE conversations ADD COLUMN is_pinned INTEGER DEFAULT 0");
  } catch (err) {
    if (!isDuplicateColumnError(err)) {
      log.error({ err }, "Failed to add is_pinned column");
      throw err;
    }
  }
}

let displayOrderColumnsEnsured = false;

export function ensureDisplayOrderMigration(): void {
  if (!displayOrderColumnsEnsured) {
    ensureDisplayOrderColumns();
    displayOrderColumnsEnsured = true;
  }
}

/**
 * Reset the in-memory `displayOrderColumnsEnsured` guard so the next
 * `ensureDisplayOrderMigration()` call re-runs. Intended ONLY for tests that
 * recreate the SQLite database mid-process (e.g. `removeTestDbFiles()` in
 * `db-conversation-inference-profile-migration.test.ts`).
 */
export function _resetDisplayOrderMigrationForTests(): void {
  displayOrderColumnsEnsured = false;
}
