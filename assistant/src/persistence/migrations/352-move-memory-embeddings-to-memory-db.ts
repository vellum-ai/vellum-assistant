import type { Database } from "bun:sqlite";

import { getMemoryDbPath } from "../../util/memory-db-path.js";
import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocationSpec,
  runMemoryTableRelocation,
} from "./helpers/relocation.js";

/**
 * How to drain `memory_embeddings` from `main` into the dedicated memory
 * database.
 *
 * The column list is explicit: the base `CREATE` columns (migration 000,
 * including `vector_blob`) plus `content_hash` (migration 102). `vector_json`
 * was made nullable by migration 026a's table rebuild. The table is polymorphic
 * (`target_type`/`target_id`, no foreign key), so there is no cascade to
 * replace — every consumer already deletes embeddings explicitly, and those
 * deletes move to the memory connection with the table.
 */
export const MEMORY_EMBEDDINGS_RELOCATION: RelocationSpec = {
  table: "memory_embeddings",
  targetDbPath: getMemoryDbPath,
  columns: [
    "id",
    "target_type",
    "target_id",
    "provider",
    "model",
    "dimensions",
    "vector_json",
    "vector_blob",
    "content_hash",
    "created_at",
    "updated_at",
  ],
};

/**
 * Create `memory_embeddings` on the memory connection. Idempotent. Recreates
 * both the inline `UNIQUE (target_type, target_id, provider, model)` constraint
 * and the equivalent named index so `ON CONFLICT` upserts resolve exactly as
 * they did on main, plus the `content_hash` lookup index (migration 102).
 */
export function ensureMemoryEmbeddingsSchema(memoryRaw: Database): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id           TEXT PRIMARY KEY,
      target_type  TEXT NOT NULL,
      target_id    TEXT NOT NULL,
      provider     TEXT NOT NULL,
      model        TEXT NOT NULL,
      dimensions   INTEGER NOT NULL,
      vector_json  TEXT,
      vector_blob  BLOB,
      content_hash TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      UNIQUE (target_type, target_id, provider, model)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_embeddings_target_provider_model
      ON memory_embeddings(target_type, target_id, provider, model);
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_content_hash
      ON memory_embeddings(content_hash, provider, model);
  `);
}

/**
 * Move `memory_embeddings` into the dedicated memory database
 * (`assistant-memory.db`), so both embedding writer families (the jobs worker's
 * `embedAndUpsert` and the persistence-side cache) and every reader ride the
 * memory connection.
 */
export async function migrateMoveMemoryEmbeddingsToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  await runMemoryTableRelocation(
    database,
    MEMORY_EMBEDDINGS_RELOCATION,
    ensureMemoryEmbeddingsSchema,
  );
}
