import type { DrizzleDb } from "../db-connection.js";

/**
 * Reorder the composite indexes from migration 137 so that `created_at`
 * leads. All usage-dashboard queries filter by `created_at` range first,
 * then GROUP BY a dimension column. With the dimension column leading,
 * SQLite couldn't use the index for the time-range scan. Leading with
 * `created_at` lets the index cover both the WHERE and GROUP BY.
 *
 * The plain `created_at`-only index is kept because other queries may rely
 * on it (and it's smaller).
 *
 * SUPERSEDED: The reordered composite indexes are also dropped by
 * migration 139 — EXPLAIN QUERY PLAN shows they still don't eliminate
 * the temp B-tree for GROUP BY.
 */
export function migrateReorderUsageDashboardIndexes(database: DrizzleDb): void {
  // Drop the old dimension-leading composites from migration 137
  database.run(
    /*sql*/ `DROP INDEX IF EXISTS idx_llm_usage_events_actor_created_at`,
  );
  database.run(
    /*sql*/ `DROP INDEX IF EXISTS idx_llm_usage_events_provider_model_created_at`,
  );

  // Create new composites with created_at leading
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_created_at_actor ON llm_usage_events(created_at, actor)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_created_at_provider_model ON llm_usage_events(created_at, provider, model)`,
  );
}
