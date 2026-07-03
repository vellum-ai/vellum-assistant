import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add supersession tracking columns and override confidence to memory_items.
 *
 * - `supersedes` — references the ID of the item this one replaces
 * - `superseded_by` — references the ID of the item that replaced this one
 * - `override_confidence` — enum: "explicit", "tentative", "inferred" (default "inferred")
 * - Index on (status, superseded_by) for filtering active non-superseded items
 *
 * All columns are added via ALTER TABLE with try/catch for idempotency.
 */
export function migrateMemoryItemSupersession(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  try {
    raw.exec(
      /*sql*/ `ALTER TABLE memory_items ADD COLUMN supersedes TEXT DEFAULT NULL`,
    );
  } catch {
    // Column already exists
  }

  try {
    raw.exec(
      /*sql*/ `ALTER TABLE memory_items ADD COLUMN superseded_by TEXT DEFAULT NULL`,
    );
  } catch {
    // Column already exists
  }

  try {
    raw.exec(
      /*sql*/ `ALTER TABLE memory_items ADD COLUMN override_confidence TEXT DEFAULT 'inferred'`,
    );
  } catch {
    // Column already exists
  }

  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_status_superseded_by ON memory_items(status, superseded_by)`,
  );
}
