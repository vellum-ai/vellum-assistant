import { getMemorySqlite } from "../db-connection.js";

/**
 * Adds `consecutive_failures` (NOT NULL, default 0) to
 * `memory_retrospective_state` in the memory database (`assistant-memory.db`,
 * where migration 346 relocated the table).
 *
 * Counts retrospective passes over the same window that produced no durable
 * memory: the retrospective job increments it on every failure path and clears
 * it on the success path. Past `RETROSPECTIVE_DEGRADE_AFTER_FAILURES` the pass
 * drops its optional skill-authoring surface and runs remember-only, so a window
 * whose richer form cannot succeed still lands facts and releases the cursor.
 * Existing rows default to 0, which reads as "no failures recorded" and matches
 * a freshly inserted row.
 *
 * Idempotent (`PRAGMA table_info` guard). Throws when the memory DB cannot be
 * opened, so the runner records the step as failed and retries on a later boot
 * rather than marking it applied without ever adding the column.
 */
export function migrateRetrospectiveConsecutiveFailures(): void {
  const raw = getMemorySqlite();
  if (!raw) {
    throw new Error(
      "memory database unavailable, deferring memory_retrospective_state consecutive_failures column add",
    );
  }

  const columns = raw
    .query(`PRAGMA table_info(memory_retrospective_state)`)
    .all() as Array<{ name: string }>;
  if (columns.length === 0) {
    throw new Error(
      "memory_retrospective_state absent from the memory database, deferring consecutive_failures column add",
    );
  }

  if (!columns.some((column) => column.name === "consecutive_failures")) {
    raw.exec(
      `ALTER TABLE memory_retrospective_state ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`,
    );
  }
}
