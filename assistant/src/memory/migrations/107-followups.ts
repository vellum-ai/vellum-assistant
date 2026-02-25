import type { DrizzleDb } from '../db-connection.js';

/**
 * Follow-ups table and indexes.
 */
export function createFollowupsTables(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS followups (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
      sent_at INTEGER NOT NULL,
      expected_response_by INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      reminder_cron_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_followups_status ON followups(status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_followups_channel ON followups(channel)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_followups_contact_id ON followups(contact_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_followups_channel_thread ON followups(channel, thread_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_followups_status_expected ON followups(status, expected_response_by)`);
}
