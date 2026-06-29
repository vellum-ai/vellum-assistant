import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Create the heartbeat_runs table for tracking heartbeat execution lifecycle.
 *
 * Each row represents one scheduled heartbeat tick, tracking its progression
 * through the status lifecycle: pending -> running -> ok/error/timeout, or
 * pending -> skipped/missed/superseded.
 */
export function migrateHeartbeatRuns(database: DrizzleDb): void {
  if (tableHasColumn(database, "heartbeat_runs", "id")) {
    return;
  }
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS heartbeat_runs (
      id TEXT PRIMARY KEY,
      scheduled_for INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      skip_reason TEXT,
      error TEXT,
      conversation_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_scheduled_for
      ON heartbeat_runs (scheduled_for)
  `);
}

export function downHeartbeatRuns(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS heartbeat_runs`);
}
