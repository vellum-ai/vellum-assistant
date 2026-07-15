import type { Database } from "bun:sqlite";

import { getMemoryDbPath } from "../../util/memory-db-path.js";
import {
  type DrizzleDb,
  getMemorySqlite,
  getSqliteFrom,
} from "../db-connection.js";
import {
  drainStagedTable,
  type RelocationSpec,
  stageTableForRelocation,
} from "./helpers/relocation.js";

/**
 * How to drain `memory_v3_selections` from `main` into the memory DB. Every
 * row is copied: the hot-set and learned-edge lanes score decayed selection
 * frequency over the full log, so there is no age cutoff a purge could lean
 * on. The column list covers migration 268's originals plus the nullable
 * columns migration 283 added — a source staged before 283 ran simply
 * NULL-fills them during the copy.
 */
export const MEMORY_V3_SELECTIONS_RELOCATION: RelocationSpec = {
  table: "memory_v3_selections",
  targetDbPath: getMemoryDbPath,
  columns: [
    "conversation_id",
    "turn",
    "slug",
    "source",
    "pinned",
    "created_at",
    "message_id",
    "section_ordinal",
    "section_title",
  ],
};

/**
 * Create the `memory_v3_selections` table and its indexes on the memory
 * connection. Idempotent (`IF NOT EXISTS`) — the dedicated connection itself
 * performs no DDL on open, so this migration owns the schema. Exported so
 * tests can stand up the memory-side schema without running the full drain.
 */
export function ensureMemoryV3SelectionsSchema(memoryRaw: Database): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_v3_selections (
      conversation_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      slug TEXT NOT NULL,
      source TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      message_id TEXT,
      section_ordinal INTEGER,
      section_title TEXT,
      PRIMARY KEY (conversation_id, turn, slug)
    )
  `);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_selections_conv
      ON memory_v3_selections (conversation_id, turn DESC)
  `);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_selections_message
      ON memory_v3_selections (message_id)
  `);
}

/**
 * Move `memory_v3_selections` — the per-turn v3 selection log feeding the
 * hot-set, learned-edge, prune, and inspector readers — into the dedicated
 * memory database (`assistant-memory.db`), alongside `memory_jobs` (298) and
 * `memory_v2_injection_events` (326). The log gains rows on every v3 turn;
 * housing it with the other high-churn memory state keeps the main DB and its
 * WAL out of that write path.
 *
 * Like migration 326 the move is incremental: create the table (and indexes)
 * on the memory connection, rename any populated `main.memory_v3_selections`
 * aside to `memory_v3_selections__relocating`, then drain it in awaited
 * batches per {@link MEMORY_V3_SELECTIONS_RELOCATION}. On a fresh install the
 * main-side table created by migration 268 is empty, so staging just drops it.
 *
 * Throws (rather than returning) if the memory database cannot be opened, so
 * the runner records the step as failed instead of applied and retries it on
 * a later boot — never renaming the source aside without a target to write
 * to. The throw is caught per-step by the runner, so startup is not aborted.
 */
export async function migrateMoveMemoryV3SelectionsToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  const memoryRaw = getMemorySqlite();
  if (!memoryRaw) {
    throw new Error(
      "memory database unavailable — deferring memory_v3_selections relocation",
    );
  }

  ensureMemoryV3SelectionsSchema(memoryRaw);

  const raw = getSqliteFrom(database);
  const needsDrain = stageTableForRelocation(
    raw,
    MEMORY_V3_SELECTIONS_RELOCATION.table,
  );

  if (needsDrain) {
    await drainStagedTable(raw, MEMORY_V3_SELECTIONS_RELOCATION);
  }
}
