import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Drop simplified-memory tables and reducer checkpoint columns added by
 * the simplified-memory-v1 plan, reverting to the legacy item/tier/XML
 * memory system.
 */
export function migrateDropSimplifiedMemory(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // Drop simplified-memory tables (idempotent — IF EXISTS).
  raw.exec(`DROP TABLE IF EXISTS time_contexts`);
  raw.exec(`DROP TABLE IF EXISTS open_loops`);
  raw.exec(`DROP TABLE IF EXISTS memory_observations`);
  raw.exec(`DROP TABLE IF EXISTS memory_chunks`);
  raw.exec(`DROP TABLE IF EXISTS memory_episodes`);

  // Remove reducer checkpoint columns from conversations.
  // SQLite doesn't support DROP COLUMN before 3.35.0, but Bun's built-in
  // SQLite is >= 3.38, so this is safe.
  for (const col of [
    "memoryReducedThroughMessageId",
    "memoryDirtyTailSinceMessageId",
    "memoryLastReducedAt",
  ]) {
    try {
      raw.exec(`ALTER TABLE conversations DROP COLUMN ${col}`);
    } catch {
      // Column doesn't exist — already cleaned up.
    }
  }

  // Remove embedding rows for archive target types that no longer exist.
  try {
    raw.exec(
      `DELETE FROM memory_embeddings WHERE targetType IN ('observation', 'chunk', 'episode')`,
    );
  } catch {
    // Column doesn't exist — table was never migrated to include targetType.
  }
}
