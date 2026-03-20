import { eq, inArray } from "drizzle-orm";

import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { memoryEmbeddings } from "../schema/memory-core.js";

/**
 * Drop the legacy memory tables (memory_items, memory_item_sources,
 * memory_segments, memory_summaries) and purge any orphaned embedding
 * rows that reference the retired target types (item, segment, summary).
 *
 * This migration is idempotent: DROP TABLE IF EXISTS and DELETE WHERE
 * are safe to re-run. The simplified-memory tables (memory_observations,
 * memory_chunks, memory_episodes) are left untouched.
 */
export function migrateDropLegacyMemorySystem(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // ── 1. Purge legacy embedding rows ────────────────────────────────
  // These target types are tied to the legacy tables being dropped.
  // Chunk/observation/episode embeddings (simplified-memory) are preserved.
  const LEGACY_TARGET_TYPES = ["item", "segment", "summary"];
  database
    .delete(memoryEmbeddings)
    .where(inArray(memoryEmbeddings.targetType, LEGACY_TARGET_TYPES))
    .run();

  // ── 2. Drop legacy tables (child → parent order for FK safety) ────
  // memory_item_sources references memory_items and messages (CASCADE),
  // memory_segments references messages (CASCADE).
  // memory_summaries is standalone.
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_item_sources`);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_segments`);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_items`);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_summaries`);

  // ── 3. Drop orphaned indexes tied only to the dropped tables ──────
  // SQLite automatically drops indexes when their table is dropped, but
  // explicitly listing them documents what was removed and guards against
  // any future schema where the index names might be reused.
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_memory_segments_scope_id`);
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_memory_items_scope_id`);
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_memory_items_fingerprint`);
  raw.exec(
    /*sql*/ `DROP INDEX IF EXISTS idx_memory_item_sources_memory_item_id`,
  );
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_memory_summaries_scope_id`);
  raw.exec(
    /*sql*/ `DROP INDEX IF EXISTS idx_memory_summaries_scope_scope_key`,
  );
}
