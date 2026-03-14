import type { DrizzleDb } from "../db-connection.js";

export function migrateChannelInteractionColumns(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE contact_channels ADD COLUMN interaction_count INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE contact_channels ADD COLUMN last_interaction INTEGER`,
    );
  } catch {
    /* already exists */
  }
}
