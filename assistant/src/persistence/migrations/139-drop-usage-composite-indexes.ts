import type { DrizzleDb } from "../db-connection.js";

/**
 * Drop all composite indexes on llm_usage_events added by migrations 137
 * and 138. EXPLAIN QUERY PLAN shows they provide no benefit: SQLite uses
 * the created_at prefix for the range scan but still needs a temp B-tree
 * for GROUP BY because the grouping column isn't contiguous after a range
 * filter. For a local SQLite DB with typical usage volumes, the plain
 * created_at index is sufficient and the temp B-tree overhead is negligible.
 *
 * The plain idx_llm_usage_events_created_at index (from migration 137)
 * is intentionally kept — it genuinely helps range scans.
 */
export function migrateDropUsageCompositeIndexes(database: DrizzleDb): void {
  // Migration 137 composites (may already be dropped by 138, hence IF EXISTS)
  database.run(
    /*sql*/ `DROP INDEX IF EXISTS idx_llm_usage_events_actor_created_at`,
  );
  database.run(
    /*sql*/ `DROP INDEX IF EXISTS idx_llm_usage_events_provider_model_created_at`,
  );

  // Migration 138 composites
  database.run(
    /*sql*/ `DROP INDEX IF EXISTS idx_llm_usage_events_created_at_actor`,
  );
  database.run(
    /*sql*/ `DROP INDEX IF EXISTS idx_llm_usage_events_created_at_provider_model`,
  );
}
