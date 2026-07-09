import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "processing_resume_attempts";
const COLUMN_DEFINITION =
  "processing_resume_attempts INTEGER NOT NULL DEFAULT 0";

/**
 * Add `processing_resume_attempts` column to the `conversations` table.
 *
 * Counts consecutive startup auto-resumes of an interrupted turn. The startup
 * reconciler (`daemon/interrupted-turn-reconciler.ts`) increments it when it
 * wakes a conversation whose `processing_started_at` was left set by a
 * previous process, and refuses to resume once the counter reaches the cap —
 * a turn that repeatedly takes the process down with it cannot resume-loop
 * across boots. A clean turn end (`setConversationProcessingStartedAt(id,
 * null)`) resets the counter to 0.
 *
 * No backfill is needed — all existing rows default to 0 (no resume attempts),
 * which is correct for any conversation that has never been auto-resumed.
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write doesn't cause a duplicate-column error on
 * the next boot.
 */
export function migrateAddProcessingResumeAttempts(database: DrizzleDb): void {
  if (tableHasColumn(database, "conversations", COLUMN_NAME)) {
    return;
  }
  database.run(`ALTER TABLE conversations ADD COLUMN ${COLUMN_DEFINITION}`);
}
