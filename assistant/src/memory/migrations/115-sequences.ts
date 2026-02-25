import type { DrizzleDb } from '../db-connection.js';

export function createSequenceTables(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS sequences (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      channel TEXT NOT NULL,
      steps TEXT NOT NULL,
      exit_on_reply INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS sequence_enrollments (
      id TEXT PRIMARY KEY,
      sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
      contact_email TEXT NOT NULL,
      contact_name TEXT,
      current_step INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      thread_id TEXT,
      next_step_at INTEGER,
      context TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_seq_enrollments_status_next_step ON sequence_enrollments(status, next_step_at)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_seq_enrollments_sequence_id ON sequence_enrollments(sequence_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_seq_enrollments_contact_email ON sequence_enrollments(contact_email)`);
}
