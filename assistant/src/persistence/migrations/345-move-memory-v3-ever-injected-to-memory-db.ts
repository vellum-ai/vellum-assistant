import type { Database } from "bun:sqlite";

import { getMemoryDbPath } from "../../util/memory-db-path.js";
import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocationSpec,
  runMemoryTableRelocation,
} from "./helpers/relocation.js";

/**
 * How to drain `memory_v3_ever_injected` from `main` into the memory DB. Full
 * copy — every (conversation, slug) row is the v3 injector's dedup and
 * resident-footprint record and is worth preserving. The table never carried a
 * foreign key (composite PK `(conversation_id, slug)`), so there is nothing to
 * drop from the schema on the way over.
 */
export const MEMORY_V3_EVER_INJECTED_RELOCATION: RelocationSpec = {
  table: "memory_v3_ever_injected",
  targetDbPath: getMemoryDbPath,
  columns: ["conversation_id", "slug", "injected_at", "bytes", "pruned_at"],
};

/**
 * Create the `memory_v3_ever_injected` table and its index (mirroring migration
 * 277) on the memory connection. Idempotent (`IF NOT EXISTS`) — the dedicated
 * connection itself performs no DDL on open, so this migration owns the schema.
 * Exported so tests can stand up the memory-side schema without running the
 * full drain.
 */
export function ensureMemoryV3EverInjectedSchema(memoryRaw: Database): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_v3_ever_injected (
      conversation_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      injected_at INTEGER NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      pruned_at INTEGER,
      PRIMARY KEY (conversation_id, slug)
    )
  `);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_ever_injected_conv
      ON memory_v3_ever_injected (conversation_id)
  `);
}

/**
 * Move `memory_v3_ever_injected` — memory-v3's per-conversation frozen-card
 * carry record — into the dedicated memory database (`assistant-memory.db`),
 * joining the plugin's other relocated per-conversation state so its store
 * reads/writes ride the memory connection. The store never JOINs
 * `conversations`, so the move is a straight full copy.
 */
export async function migrateMoveMemoryV3EverInjectedToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  await runMemoryTableRelocation(
    database,
    MEMORY_V3_EVER_INJECTED_RELOCATION,
    ensureMemoryV3EverInjectedSchema,
  );
}
