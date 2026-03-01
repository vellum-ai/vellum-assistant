import type { DrizzleDb } from '../db-connection.js';

/**
 * Add guardian_principal_id columns to channel_guardian_bindings and
 * canonical_guardian_requests, plus decided_by_principal_id to
 * canonical_guardian_requests.
 *
 * These nullable TEXT columns support the canonical identity binding
 * cutover — linking guardian bindings and approval requests to a
 * stable principal identity rather than relying solely on
 * channel-specific external user IDs.
 *
 * Uses ALTER TABLE ADD COLUMN with try/catch for idempotency.
 */
export function migrateGuardianPrincipalIdColumns(database: DrizzleDb): void {
  try { database.run(/*sql*/ `ALTER TABLE channel_guardian_bindings ADD COLUMN guardian_principal_id TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE canonical_guardian_requests ADD COLUMN guardian_principal_id TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE canonical_guardian_requests ADD COLUMN decided_by_principal_id TEXT`); } catch { /* already exists */ }
}
