import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Add source_type and source_message_role columns to memory_items.
 *
 * - source_type: "extraction" (default) or "tool" — distinguishes how the
 *   memory was created (LLM/pattern extraction vs explicit tool/API save).
 * - source_message_role: the role of the source message (e.g. "user",
 *   "assistant") when the item was created via extraction.
 *
 * Backfills:
 * 1. Items with verification_state = "user_confirmed" → source_type = "tool"
 * 2. source_message_role from the earliest source message's role via subquery
 */
export function migrateAddSourceTypeColumns(database: DrizzleDb): void {
  withCrashRecovery(database, "migration_add_source_type_columns_v1", () => {
    const raw = getSqliteFrom(database);

    // Add source_type column if it doesn't exist
    if (!tableHasColumn(database, "memory_items", "source_type")) {
      raw.exec(
        /*sql*/ `ALTER TABLE memory_items ADD COLUMN source_type TEXT NOT NULL DEFAULT 'extraction'`,
      );
    }

    // Add source_message_role column if it doesn't exist
    if (!tableHasColumn(database, "memory_items", "source_message_role")) {
      raw.exec(
        /*sql*/ `ALTER TABLE memory_items ADD COLUMN source_message_role TEXT`,
      );
    }

    // Backfill source_type = 'tool' for items that were explicitly saved
    raw.exec(
      /*sql*/ `UPDATE memory_items SET source_type = 'tool' WHERE verification_state = 'user_confirmed'`,
    );

    // Backfill source_message_role from the earliest source message's role.
    // Only backfill where source_message_role is currently NULL and a source
    // message exists.
    raw.exec(/*sql*/ `
        UPDATE memory_items
        SET source_message_role = (
          SELECT m.role
          FROM memory_item_sources mis
          JOIN messages m ON m.id = mis.message_id
          WHERE mis.memory_item_id = memory_items.id
          ORDER BY mis.created_at ASC
          LIMIT 1
        )
        WHERE source_message_role IS NULL
          AND EXISTS (
            SELECT 1
            FROM memory_item_sources mis
            WHERE mis.memory_item_id = memory_items.id
          )
      `);
  });
}

/**
 * Reverse: drop source_type and source_message_role columns.
 *
 * SQLite doesn't support DROP COLUMN on older versions, but modern SQLite
 * (3.35.0+) does. Since Bun bundles a modern SQLite, this is safe.
 */
export function migrateAddSourceTypeColumnsDown(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  if (tableHasColumn(database, "memory_items", "source_type")) {
    raw.exec(/*sql*/ `ALTER TABLE memory_items DROP COLUMN source_type`);
  }
  if (tableHasColumn(database, "memory_items", "source_message_role")) {
    raw.exec(
      /*sql*/ `ALTER TABLE memory_items DROP COLUMN source_message_role`,
    );
  }
}
