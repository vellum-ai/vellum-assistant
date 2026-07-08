import type { DrizzleDb } from "../db-connection.js";

/**
 * Contacts, contact channels, and triage results tables with indexes.
 */
export function createContactsAndTriageTables(database: DrizzleDb): void {
  // Columns removed: relationship, importance, response_expectation, preferred_tone
  // — dropped by migration 134 (contacts-notes-column). Omitting them here keeps
  //   the CREATE TABLE idempotent when initializeDb() runs a second time (e.g. the
  //   "daemon restart" tests) after migration 134 has already dropped them.
  // Index removed: idx_contacts_last_interaction — the last_interaction column is
  //   dropped by migration 159. Omitting the index avoids re-creating it on fresh
  //   databases only for migration 159 to immediately drop it.
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      last_interaction INTEGER,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS contact_channels (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      address TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_contacts_display_name ON contacts(display_name)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_contact_channels_contact_id ON contact_channels(contact_id)`,
  );
  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_channels_type_address ON contact_channels(type, address)`,
  );

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS triage_results (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      sender TEXT NOT NULL,
      category TEXT NOT NULL,
      confidence REAL NOT NULL,
      suggested_action TEXT NOT NULL,
      matched_playbook_ids TEXT,
      message_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_triage_results_channel ON triage_results(channel)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_triage_results_category ON triage_results(category)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_triage_results_sender ON triage_results(sender)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_triage_results_created_at ON triage_results(created_at DESC)`,
  );
}
