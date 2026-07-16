import type { Database } from "bun:sqlite";

import { getMemoryDbPath } from "../../util/memory-db-path.js";
import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocationSpec,
  runMemoryTableRelocation,
} from "./helpers/relocation.js";

/**
 * Readers of `memory_v2_injection_events` bound their scans to the last
 * 6 half-lives (6 × 3 days) — events past that window contribute <1.6% each
 * to the decayed score and are never queried. Mirrors `READ_WINDOW_MS` in
 * `plugins/defaults/memory/v2/injection-events.ts` (duplicated by design:
 * persistence migrations do not import plugin code).
 */
const READ_WINDOW_MS = 6 * 3 * 24 * 60 * 60 * 1000;

/**
 * How to drain `memory_v2_injection_events` from `main` into the memory DB.
 * Rows older than the score read window are purged without copying — no
 * reader ever looks at them, so carrying them over would only re-seed dead
 * weight in the new file.
 */
export const INJECTION_EVENTS_RELOCATION: RelocationSpec = {
  table: "memory_v2_injection_events",
  targetDbPath: getMemoryDbPath,
  columns: ["id", "slug", "injected_at"],
  copyWhere: `injected_at >= strftime('%s','now') * 1000 - ${READ_WINDOW_MS}`,
};

const CREATE_TABLE = /*sql*/ `
  CREATE TABLE IF NOT EXISTS memory_v2_injection_events (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL,
    injected_at INTEGER NOT NULL
  )
`;

/**
 * Create the `memory_v2_injection_events` table and its indexes on the memory
 * connection. Idempotent (`IF NOT EXISTS`) — the dedicated connection itself
 * performs no DDL on open, so this migration owns the schema. Exported so
 * tests can stand up the memory-side schema without running the full drain.
 */
export function ensureInjectionEventsSchema(memoryRaw: Database): void {
  memoryRaw.exec(CREATE_TABLE);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v2_injection_events_slug_time
      ON memory_v2_injection_events (slug, injected_at)
  `);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v2_injection_events_time
      ON memory_v2_injection_events (injected_at)
  `);
}

/**
 * Move `memory_v2_injection_events` — the append-only EMA event log behind
 * memory router tier-2 scoring — into the dedicated memory database
 * (`assistant-memory.db`), alongside `memory_jobs` (migration 298). The log
 * grows with every router selection; housing it with the other high-churn
 * memory state keeps the main DB and its WAL out of that write path, and the
 * accessors in `plugins/defaults/memory/v2/injection-events.ts` read/write it
 * over the dedicated memory connection (see `getMemoryDb()`).
 *
 * On a fresh install the main-side table created by migration 256 is empty,
 * so staging just drops it.
 */
export async function migrateMoveInjectionEventsToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  await runMemoryTableRelocation(
    database,
    INJECTION_EVENTS_RELOCATION,
    ensureInjectionEventsSchema,
  );
}
