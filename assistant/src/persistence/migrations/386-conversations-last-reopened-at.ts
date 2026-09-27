import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

export function migrateConversationsLastReopenedAt(database: DrizzleDb): void {
  if (!tableHasColumn(database, "conversations", "last_reopened_at")) {
    getSqliteFrom(database).exec(
      "ALTER TABLE conversations ADD COLUMN last_reopened_at INTEGER",
    );
  }
}
