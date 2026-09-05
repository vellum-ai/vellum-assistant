import type { Database } from "bun:sqlite";

import { getMemorySqlite } from "../db-connection.js";

/**
 * Create `memory_v3_pools` and its indexes on the memory connection. One row
 * per `(conversation, turn)`: the memory-v3 selector's full candidate pool for
 * that turn (stable-prefix cards and finder lines, in pool order) with each
 * candidate's verdict, serialized as JSON in `candidates_json`, and
 * `selector_ran` (0 for a turn whose selector never judged a pool, which is
 * persisted as an empty pool). Idempotent (`IF NOT EXISTS`); the dedicated
 * connection performs no DDL on open, so this migration owns the schema.
 * Exported so tests can stand up the memory-side schema directly.
 */
export function ensureMemoryV3PoolsSchema(memoryRaw: Database): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_v3_pools (
      conversation_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      message_id TEXT,
      created_at INTEGER NOT NULL,
      pool_size INTEGER NOT NULL,
      selected_count INTEGER NOT NULL,
      selector_ran INTEGER NOT NULL DEFAULT 1,
      candidates_json TEXT NOT NULL,
      PRIMARY KEY (conversation_id, turn)
    )
  `);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_pools_message
      ON memory_v3_pools (message_id)
  `);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_pools_conv
      ON memory_v3_pools (conversation_id, turn DESC)
  `);
}

/**
 * Add `memory_v3_pools`, the per-turn audit record of the memory-v3 selector's
 * candidate pool and verdict, to the dedicated memory database
 * (`assistant-memory.db`) next to `memory_v3_selections`. The table is new
 * (nothing to relocate out of `main`), so the step is DDL only.
 *
 * Throws when the memory database cannot be opened so the runner records the
 * step as failed and retries it on a later boot, instead of checkpointing a
 * schema that was never created.
 */
export function migrateAddMemoryV3Pools(): void {
  const memoryRaw = getMemorySqlite();
  if (!memoryRaw) {
    throw new Error(
      "memory database unavailable; deferring memory_v3_pools creation",
    );
  }
  ensureMemoryV3PoolsSchema(memoryRaw);
}
