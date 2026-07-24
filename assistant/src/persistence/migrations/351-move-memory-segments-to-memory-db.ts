import type { Database } from "bun:sqlite";

import { getMemoryDbPath } from "../../util/memory-db-path.js";
import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocationSpec,
  runMemoryTableRelocation,
} from "./helpers/relocation.js";

/**
 * How to drain `memory_segments` from `main` into the dedicated memory database.
 *
 * The column list is explicit (never `SELECT *`) so the copy is insensitive to
 * the physical order left by the `ALTER TABLE … ADD COLUMN` history: the base
 * `CREATE` columns (migration 000) plus `scope_id` and `content_hash` (both
 * added by migration 102). `scope_id` is a real `NOT NULL DEFAULT 'default'`
 * column even though the Drizzle schema does not map it — dropping it here would
 * lose that data on the drain.
 *
 * The `message_id`/`conversation_id` foreign keys to `messages`/`conversations`
 * are NOT recreated on the memory side (see {@link ensureMemorySegmentsSchema}):
 * SQLite cannot cascade across database files, so the conversation- and
 * message-delete paths replace that cascade with explicit deletes on the memory
 * connection. The `memory_segment_fts` table and its sync triggers (migration
 * 101) were already removed by migration 154, so nothing else moves with it.
 */
export const MEMORY_SEGMENTS_RELOCATION: RelocationSpec = {
  table: "memory_segments",
  targetDbPath: getMemoryDbPath,
  columns: [
    "id",
    "message_id",
    "conversation_id",
    "role",
    "segment_index",
    "text",
    "token_estimate",
    "scope_id",
    "content_hash",
    "created_at",
    "updated_at",
  ],
};

/**
 * Create `memory_segments` on the memory connection. Idempotent
 * (`IF NOT EXISTS`) — the dedicated connection performs no DDL on open, so this
 * migration owns the schema. The `message_id`/`conversation_id` columns keep
 * their values but drop the cross-file `REFERENCES`; the indexes mirror
 * migrations 016 and 102.
 */
export function ensureMemorySegmentsSchema(memoryRaw: Database): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_segments (
      id              TEXT PRIMARY KEY,
      message_id      TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL,
      segment_index   INTEGER NOT NULL,
      text            TEXT NOT NULL,
      token_estimate  INTEGER NOT NULL,
      scope_id        TEXT NOT NULL DEFAULT 'default',
      content_hash    TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_segments_message_segment
      ON memory_segments(message_id, segment_index);
    CREATE INDEX IF NOT EXISTS idx_memory_segments_conversation_created
      ON memory_segments(conversation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_segments_scope_id
      ON memory_segments(scope_id);
  `);
}

/**
 * Move `memory_segments` into the dedicated memory database
 * (`assistant-memory.db`), so the indexer, summarizer, semantic search, and the
 * conversation/message delete paths all ride the memory connection.
 *
 * Registered with `dependsOn` on every migration that reads or writes
 * `memory_segments` on main so the move never outruns one where those rows are
 * still expected there — including `migrateDeletePrivateConversations`, which
 * runs `DELETE FROM messages` relying on the segment cascade.
 */
export async function migrateMoveMemorySegmentsToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  await runMemoryTableRelocation(
    database,
    MEMORY_SEGMENTS_RELOCATION,
    ensureMemorySegmentsSchema,
  );
}
