import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const COLUMN_NAME = "credential_paused_at";
const COLUMN_DEFINITION = "credential_paused_at INTEGER";

/**
 * Add the nullable `credential_paused_at` column to the `watchers` table.
 *
 * Records the epoch-ms instant a watcher's poll was paused because its
 * credential became unhealthy (revoked, missing, or unrecoverably expired).
 * The watcher engine's pre-poll credential gate sets it on the
 * healthy→unhealthy transition and clears it back to null once the credential
 * recovers, so the value doubles as the dedup marker for the one-shot
 * "monitoring paused" notification and as the paused indicator surfaced in
 * `watchers list`.
 *
 * No backfill is needed — existing rows default to null (not paused), which is
 * correct for any watcher whose credential has never been observed unhealthy.
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write doesn't raise a duplicate-column error on
 * the next boot.
 */
export function migrateWatchersCredentialPausedAt(database: DrizzleDb): void {
  if (tableHasColumn(database, "watchers", COLUMN_NAME)) {
    return;
  }
  database.run(`ALTER TABLE watchers ADD COLUMN ${COLUMN_DEFINITION}`);
}
