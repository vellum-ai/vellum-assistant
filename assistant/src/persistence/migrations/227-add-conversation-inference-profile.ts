import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateAddConversationInferenceProfile(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  const columns = raw.query(`PRAGMA table_info(conversations)`).all() as Array<{
    name: string;
  }>;
  // Skip if either the original camelCase column or the renamed snake_case
  // column from migration 228 is already present. Without the snake_case
  // check, this migration would re-add the camelCase column on every boot
  // after 228 runs, leaving both columns permanently.
  const hasColumn = columns.some(
    (column) =>
      column.name === "inferenceProfile" || column.name === "inference_profile",
  );
  if (hasColumn) {
    return;
  }
  raw.exec(`ALTER TABLE conversations ADD COLUMN inferenceProfile TEXT`);
}
