import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateAddConversationInferenceProfile(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  const columns = raw.query(`PRAGMA table_info(conversations)`).all() as Array<{
    name: string;
  }>;
  const hasColumn = columns.some(
    (column) => column.name === "inferenceProfile",
  );
  if (hasColumn) {
    return;
  }
  raw.exec(`ALTER TABLE conversations ADD COLUMN inferenceProfile TEXT`);
}
