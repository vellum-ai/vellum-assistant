import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Rename `conversations.inferenceProfile` (camelCase, accidentally introduced
 * by migration 227) to `inference_profile` so it matches the snake_case
 * convention used by every other column on the table.
 *
 * Idempotent and self-healing:
 * - both columns present → drop the camelCase one (heals instances that
 *   already booted twice with the original buggy migration 227, where 227
 *   re-added the camelCase column after this migration renamed it).
 * - camelCase column present, snake_case absent → rename it.
 * - snake_case column present, camelCase absent → no-op.
 * - neither column present → no-op.
 */
export function migrateRenameInferenceProfileSnakeCase(
  database: DrizzleDb,
): void {
  const hasSnake = tableHasColumn(
    database,
    "conversations",
    "inference_profile",
  );
  const hasCamel = tableHasColumn(
    database,
    "conversations",
    "inferenceProfile",
  );
  if (hasSnake && hasCamel) {
    database.run(`ALTER TABLE conversations DROP COLUMN inferenceProfile`);
    return;
  }
  if (!hasCamel) {
    return;
  }
  database.run(
    `ALTER TABLE conversations RENAME COLUMN inferenceProfile TO inference_profile`,
  );
}
