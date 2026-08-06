import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMNS: ReadonlyArray<{ name: string; definition: string }> = [
  { name: "source_key", definition: "source_key TEXT" },
  { name: "definition_hash", definition: "definition_hash TEXT" },
  { name: "user_enabled", definition: "user_enabled INTEGER" },
];

/**
 * Add plugin-declaration provenance columns to `cron_jobs`.
 *
 * `source_key` links a schedule row to the plugin declaration it was
 * reconciled from (`plugin:<pluginName>/<scheduleName>`). Rows with a NULL
 * `source_key` are imperative schedules and keep their existing behavior.
 * `definition_hash` is the reconciler's change detector over the declaration
 * files. `user_enabled` is the user's enable/disable override for a sourced
 * row; NULL means the declaration's own enabled value applies.
 *
 * The unique index is partial (`WHERE source_key IS NOT NULL`) so the many
 * NULL rows stay unconstrained while a given declaration resolves to exactly
 * one row. The reconciler's upsert depends on that uniqueness.
 *
 * Nullable with no backfill: nothing recorded declaration provenance before
 * these columns existed, so pre-existing rows correctly stay NULL.
 *
 * Idempotent: each column add is guarded with `tableHasColumn` and the index
 * with `IF NOT EXISTS`, so a crash partway through does not break the next
 * boot.
 */
export function migrateAddScheduleSourceKey(database: DrizzleDb): void {
  for (const column of COLUMNS) {
    if (!tableHasColumn(database, "cron_jobs", column.name)) {
      database.run(`ALTER TABLE cron_jobs ADD COLUMN ${column.definition}`);
    }
  }

  database.run(/*sql*/ `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_jobs_source_key
    ON cron_jobs(source_key)
    WHERE source_key IS NOT NULL
  `);
}
