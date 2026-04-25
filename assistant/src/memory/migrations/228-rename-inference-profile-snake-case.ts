import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Rename `conversations.inferenceProfile` (camelCase, accidentally introduced
 * by migration 227) to `inference_profile` so it matches the snake_case
 * convention used by every other column on the table.
 *
 * Idempotent:
 * - camelCase column present, snake_case absent → renames it.
 * - snake_case column already present → no-op.
 * - neither column present → no-op (shouldn't happen since 227 ran first,
 *   but we guard for completeness).
 */
export function migrateRenameInferenceProfileSnakeCase(
  database: DrizzleDb,
): void {
  if (tableHasColumn(database, "conversations", "inference_profile")) {
    return;
  }
  if (!tableHasColumn(database, "conversations", "inferenceProfile")) {
    return;
  }
  database.run(
    `ALTER TABLE conversations RENAME COLUMN inferenceProfile TO inference_profile`,
  );
}
