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
