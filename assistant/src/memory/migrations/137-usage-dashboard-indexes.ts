import type { DrizzleDb } from "../db-connection.js";

/**
 * Idempotent migration to add indexes on llm_usage_events for the
 * time-range and breakdown queries the usage dashboard needs.
 *
 * - Covering index on (created_at) for efficient time-range scans.
 * - Composite index on (actor, created_at) for per-actor breakdowns.
 * - Composite index on (provider, model, created_at) for provider/model grouping.
 */
export function migrateUsageDashboardIndexes(database: DrizzleDb): void {
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_created_at ON llm_usage_events(created_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_actor_created_at ON llm_usage_events(actor, created_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_provider_model_created_at ON llm_usage_events(provider, model, created_at)`,
  );
}
