import type { DrizzleDb } from "../db-connection.js";

/**
 * Add the `origin_interface` text column to `conversations` — nullable,
 * mirroring the existing `origin_channel` column.
 *
 * Uses ALTER TABLE ADD COLUMN which is a no-op if the column already
 * exists (caught via try/catch, matching the existing migration pattern).
 */
export function migrateAddOriginInterface(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN origin_interface TEXT`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
}
