import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Reverse v16: rebuild channel_guardian_bindings to make guardian_principal_id
 * nullable again (removing the NOT NULL constraint added by the forward migration).
 */
export function downGuardianPrincipalIdNotNull(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const tableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_guardian_bindings'`,
    )
    .get();
  if (!tableExists) return;

  // Check if guardian_principal_id has NOT NULL — if not, already rolled back
  const colInfo = raw
    .query(
      `SELECT "notnull" FROM pragma_table_info('channel_guardian_bindings') WHERE name = 'guardian_principal_id'`,
    )
    .get() as { notnull: number } | null;
  if (!colInfo || colInfo.notnull === 0) return;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec("BEGIN");

    raw.exec(/*sql*/ `
      CREATE TABLE channel_guardian_bindings_new (
        id TEXT PRIMARY KEY,
        assistant_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        guardian_external_user_id TEXT NOT NULL,
        guardian_delivery_chat_id TEXT NOT NULL,
        guardian_principal_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        verified_at INTEGER NOT NULL,
        verified_via TEXT NOT NULL DEFAULT 'challenge',
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      INSERT INTO channel_guardian_bindings_new
      SELECT id, assistant_id, channel, guardian_external_user_id,
             guardian_delivery_chat_id, guardian_principal_id,
             status, verified_at, verified_via, metadata_json,
             created_at, updated_at
      FROM channel_guardian_bindings
    `);

    raw.exec(/*sql*/ `DROP TABLE channel_guardian_bindings`);
    raw.exec(
      /*sql*/ `ALTER TABLE channel_guardian_bindings_new RENAME TO channel_guardian_bindings`,
    );

    // Recreate the unique index for active bindings
    raw.exec(/*sql*/ `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_guardian_bindings_active
      ON channel_guardian_bindings(assistant_id, channel)
      WHERE status = 'active'
    `);

    raw.exec("COMMIT");
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

/**
 * Enforce NOT NULL on channel_guardian_bindings.guardian_principal_id.
 *
 * Migration 125 added the column as nullable, and migration 126 backfilled
 * existing rows. This migration:
 *
 * 1. Backfills any remaining null guardian_principal_id rows with
 *    guardian_external_user_id as a sensible default (same fallback
 *    strategy used by migration 126).
 * 2. Rebuilds the table to add a NOT NULL constraint on the column
 *    (SQLite does not support ALTER COLUMN).
 *
 * Idempotent: checks the DDL before rebuilding; skips if the column
 * already has NOT NULL.
 */
export function migrateGuardianPrincipalIdNotNull(database: DrizzleDb): void {
  withCrashRecovery(
    database,
    "migration_guardian_principal_id_not_null_v1",
    () => {
      const raw = getSqliteFrom(database);

      // Guard: table must exist
      const tableExists = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_guardian_bindings'`,
        )
        .get();
      if (!tableExists) return;

      // Guard: column must exist (added by migration 125)
      const colExists = raw
        .query(
          `SELECT 1 FROM pragma_table_info('channel_guardian_bindings') WHERE name = 'guardian_principal_id'`,
        )
        .get();
      if (!colExists) return;

      // Check if the column already has NOT NULL (idempotency)
      const colInfo = raw
        .query(
          `SELECT "notnull" FROM pragma_table_info('channel_guardian_bindings') WHERE name = 'guardian_principal_id'`,
        )
        .get() as { notnull: number } | null;
      if (colInfo && colInfo.notnull === 1) return;

      raw.exec("PRAGMA foreign_keys = OFF");
      try {
        raw.exec("BEGIN");

        // Backfill any remaining null rows before adding the constraint
        raw.exec(/*sql*/ `
        UPDATE channel_guardian_bindings
        SET guardian_principal_id = guardian_external_user_id,
            updated_at = ${Date.now()}
        WHERE guardian_principal_id IS NULL
          AND guardian_external_user_id IS NOT NULL
      `);

        // For any rows where even guardian_external_user_id is null (shouldn't
        // happen but defensive), use 'unknown' as a placeholder
        raw.exec(/*sql*/ `
        UPDATE channel_guardian_bindings
        SET guardian_principal_id = 'unknown',
            updated_at = ${Date.now()}
        WHERE guardian_principal_id IS NULL
      `);

        // Rebuild the table with NOT NULL on guardian_principal_id
        raw.exec(/*sql*/ `
        CREATE TABLE channel_guardian_bindings_new (
          id TEXT PRIMARY KEY,
          assistant_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          guardian_external_user_id TEXT NOT NULL,
          guardian_delivery_chat_id TEXT NOT NULL,
          guardian_principal_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          verified_at INTEGER NOT NULL,
          verified_via TEXT NOT NULL DEFAULT 'challenge',
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

        raw.exec(/*sql*/ `
        INSERT INTO channel_guardian_bindings_new
        SELECT id, assistant_id, channel, guardian_external_user_id,
               guardian_delivery_chat_id, guardian_principal_id,
               status, verified_at, verified_via, metadata_json,
               created_at, updated_at
        FROM channel_guardian_bindings
      `);

        raw.exec(/*sql*/ `DROP TABLE channel_guardian_bindings`);
        raw.exec(
          /*sql*/ `ALTER TABLE channel_guardian_bindings_new RENAME TO channel_guardian_bindings`,
        );

        // Recreate the unique index for active bindings
        raw.exec(/*sql*/ `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_guardian_bindings_active
        ON channel_guardian_bindings(assistant_id, channel)
        WHERE status = 'active'
      `);

        raw.exec("COMMIT");
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
    },
  );
}
