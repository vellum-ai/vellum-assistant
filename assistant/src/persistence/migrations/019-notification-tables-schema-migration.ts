import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * One-time migration: drop legacy enum-based notification tables so they can
 * be recreated with the new signal-contract schema.
 *
 * Guard: only runs when the old `notification_type` column exists on the
 * `notification_events` table (the old enum-based schema).  On fresh installs
 * the table either doesn't exist yet or was created with the new schema, so
 * CREATE TABLE IF NOT EXISTS in db-init handles idempotent creation.
 *
 * Drop order matters because of FK references:
 *   notification_deliveries -> notification_events  (old schema FK)
 *   notification_decisions  -> notification_events  (new schema FK, may exist from partial upgrade)
 *   notification_events     (the table being rebuilt)
 *   notification_preferences (fully removed, replaced by decision engine)
 */
export function migrateNotificationTablesSchema(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = "migration_notification_tables_schema_v1";
  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  // Check if the old schema is present: the legacy notification_events table
  // had a `notification_type` column that the new schema does not.
  const hasOldSchema = raw
    .query(
      `SELECT COUNT(*) as cnt FROM pragma_table_info('notification_events') WHERE name = 'notification_type'`,
    )
    .get() as { cnt: number } | undefined;

  if (hasOldSchema && hasOldSchema.cnt > 0) {
    try {
      raw.exec("BEGIN");

      // Drop in FK-safe order: children before parents
      raw.exec(/*sql*/ `DROP TABLE IF EXISTS notification_deliveries`);
      raw.exec(/*sql*/ `DROP TABLE IF EXISTS notification_decisions`);
      raw.exec(/*sql*/ `DROP TABLE IF EXISTS notification_events`);
      raw.exec(/*sql*/ `DROP TABLE IF EXISTS notification_preferences`);

      raw
        .query(
          `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
        )
        .run(checkpointKey, Date.now());

      raw.exec("COMMIT");
    } catch (e) {
      try {
        raw.exec("ROLLBACK");
      } catch {
        /* no active transaction */
      }
      throw e;
    }
  } else {
    // No old schema detected (fresh install or already migrated).
    // Still clean up notification_preferences if it exists, since we want
    // to ensure it's removed regardless.
    try {
      raw.exec("BEGIN");

      raw.exec(/*sql*/ `DROP TABLE IF EXISTS notification_preferences`);

      raw
        .query(
          `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
        )
        .run(checkpointKey, Date.now());

      raw.exec("COMMIT");
    } catch (e) {
      try {
        raw.exec("ROLLBACK");
      } catch {
        /* no active transaction */
      }
      throw e;
    }
  }
}

/**
 * No-op down: the old enum-based notification tables cannot be recreated
 * without the original schema definitions (column names, types, constraints,
 * and enum values). The forward migration dropped these tables entirely.
 * Any data that was in them is permanently lost. The new signal-contract
 * schema tables are structurally incompatible with the old enum-based ones.
 */
export function downNotificationTablesSchema(_database: DrizzleDb): void {
  // Intentionally empty — old enum-based tables cannot be recreated without
  // the original schema, and any data they contained is permanently lost.
}
