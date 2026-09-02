import type { Database } from "bun:sqlite";

import { type DrizzleDb, getMemorySqlite } from "../db-connection.js";

const TABLE = "memory_retrospective_state";
const COLUMN = "consecutive_failures";

/**
 * Add `consecutive_failures INTEGER NOT NULL DEFAULT 0` to
 * `memory_retrospective_state` on the memory database.
 *
 * The retrospective job increments this on each unusable attempt and
 * advances the cursor after three consecutive failures so the sweep
 * cannot re-enqueue the same unresolvable window forever.
 *
 * Existing rows receive 0. Idempotent: the PRAGMA guard makes a second
 * run a no-op. Throws when the memory database is unavailable so the
 * runner defers and retries on a later boot.
 */
export function addMemoryRetrospectiveConsecutiveFailuresColumn(
  memoryRaw: Database,
): void {
  const columns = memoryRaw
    .query(`PRAGMA table_info(${TABLE})`)
    .all() as Array<{ name: string }>;
  if (columns.length === 0) {
    return;
  }
  if (columns.some((column) => column.name === COLUMN)) {
    return;
  }
  memoryRaw.exec(
    `ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} INTEGER NOT NULL DEFAULT 0`,
  );
}

export function migrateAddMemoryRetrospectiveConsecutiveFailures(
  _database: DrizzleDb,
): void {
  const memoryRaw = getMemorySqlite();
  if (!memoryRaw) {
    throw new Error(
      "memory database unavailable: deferring consecutive-failures column",
    );
  }
  addMemoryRetrospectiveConsecutiveFailuresColumn(memoryRaw);
}
