import type { DrizzleDb } from "../db-connection.js";

export function migrateAssistantContactMetadata(database: DrizzleDb): void {
  // Add contact_type column to contacts
  try {
    database.run(
      /*sql*/ `ALTER TABLE contacts ADD COLUMN contact_type TEXT NOT NULL DEFAULT 'human'`,
    );
  } catch {
    /* already exists */
  }

  // Create assistant_contact_metadata table
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS assistant_contact_metadata (
      contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
      species TEXT NOT NULL,
      metadata TEXT
    )
  `);
}
