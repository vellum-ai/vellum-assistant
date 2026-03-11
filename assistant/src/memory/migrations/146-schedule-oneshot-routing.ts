import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Extend cron_jobs table with one-shot and routing support.
 *
 * - Make `cron_expression` nullable (SQLite requires table rebuild for
 *   nullability changes). One-shot schedules have NULL cron_expression.
 * - Add `mode` column: 'notify' | 'execute'
 * - Add `routing_intent` column: 'single_channel' | 'multi_channel' | 'all_channels'
 * - Add `routing_hints_json` column: opaque JSON routing hints
 * - Add `status` column: 'active' | 'firing' | 'fired' | 'cancelled'
 * - Add composite index for one-shot claiming: (status, next_run_at)
 */
export function migrateScheduleOneShotRouting(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // Check if migration is already done by inspecting whether the status column exists
  const tableInfo = raw
    .query("PRAGMA table_info(cron_jobs)")
    .all() as Array<{ name: string }>;
  const hasStatusColumn = tableInfo.some((col) => col.name === "status");
  if (hasStatusColumn) {
    // Ensure all indexes exist even if the column migration already ran
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled_next_run ON cron_jobs(enabled, next_run_at)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_cron_jobs_syntax_enabled_next_run ON cron_jobs(schedule_syntax, enabled, next_run_at)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_cron_jobs_status_next_run_at ON cron_jobs(status, next_run_at)`,
    );
    return;
  }

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec(/*sql*/ `
      BEGIN;

      CREATE TABLE cron_jobs_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        cron_expression TEXT,
        schedule_syntax TEXT NOT NULL DEFAULT 'cron',
        timezone TEXT,
        message TEXT NOT NULL,
        next_run_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_status TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'execute',
        routing_intent TEXT NOT NULL DEFAULT 'all_channels',
        routing_hints_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO cron_jobs_new (
        id, name, enabled, cron_expression, schedule_syntax, timezone,
        message, next_run_at, last_run_at, last_status, retry_count,
        created_by, mode, routing_intent, routing_hints_json, status,
        created_at, updated_at
      )
      SELECT
        id, name, enabled, cron_expression, schedule_syntax, timezone,
        message, next_run_at, last_run_at, last_status, retry_count,
        created_by, 'execute', 'all_channels', '{}', 'active',
        created_at, updated_at
      FROM cron_jobs;

      DROP TABLE cron_jobs;
      ALTER TABLE cron_jobs_new RENAME TO cron_jobs;

      CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled_next_run ON cron_jobs(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_syntax_enabled_next_run ON cron_jobs(schedule_syntax, enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_status_next_run_at ON cron_jobs(status, next_run_at);

      COMMIT;
    `);
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
}
