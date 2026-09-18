import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const TABLE_NAME = "oauth_providers";
const COLUMN_NAME = "response_ok_field";
const COLUMN_DEFINITION = "response_ok_field TEXT";

/**
 * Add `response_ok_field` to `oauth_providers` (migration 149): the dot path
 * of the boolean a provider's API puts in every response body to report
 * success (Slack: `ok`). Its own column, distinct from `identity_ok_field`,
 * because the two declare different facts: the identity field governs the
 * one call the provider row names, this one governs any request made with
 * the credential.
 *
 * Nullable with no backfill: seeding upserts the value for the built-in rows
 * on the next start, and a custom provider that declares nothing is judged by
 * status alone, which is what it was before the column existed.
 *
 * Idempotent: guarded with `tableHasColumn` so a crash between the `ALTER
 * TABLE` and the checkpoint write doesn't cause a duplicate-column error on
 * the next boot. A missing table is not swallowed: the registry declares the
 * dependency on the table's own step, so this one is deferred rather than
 * checkpointed as done against no table.
 */
export function migrateOAuthProvidersResponseOkField(
  database: DrizzleDb,
): void {
  if (!tableHasColumn(database, TABLE_NAME, COLUMN_NAME)) {
    database.run(`ALTER TABLE ${TABLE_NAME} ADD COLUMN ${COLUMN_DEFINITION}`);
  }
}
