import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_sync_changes_v1";

export function migrateSyncChanges(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS sync_changes (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        resource TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        op TEXT NOT NULL,
        version INTEGER,
        invalidated_tags_json TEXT NOT NULL,
        origin_client_id TEXT,
        metadata_json TEXT
      )
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_sync_changes_created_at
        ON sync_changes (created_at)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_sync_changes_resource
        ON sync_changes (resource, resource_id)
    `);
  });
}

export function downSyncChanges(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS sync_changes`);
}
