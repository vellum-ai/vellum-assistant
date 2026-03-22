import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Drop the unused legacy accounts table and its indexes.
 *
 * The daemon no longer exposes account_manage or reads from the backing
 * account-store path, so retaining the table only leaves dead state around.
 */
export function migrateDropAccountsTable(database: DrizzleDb): void {
  withCrashRecovery(database, "migration_drop_accounts_table_v1", () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_accounts_service`);
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_accounts_status`);
    raw.exec(/*sql*/ `DROP TABLE IF EXISTS accounts`);
  });
}

/**
 * Reverse: recreate the accounts table with its original schema.
 *
 * Data is permanently lost — the table was dropped. This only restores the
 * empty table structure so that earlier migrations referencing it can operate.
 */
export function migrateDropAccountsTableDown(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      username TEXT,
      email TEXT,
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      credential_ref TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_accounts_service ON accounts(service)`,
  );
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status)`,
  );
}
