import { getSqliteFrom, type DrizzleDb } from '../db-connection.js';

/**
 * Create guardian_action_requests and guardian_action_deliveries tables
 * for cross-channel voice guardian dispatch.
 *
 * Uses CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS for
 * idempotency across restarts.
 */
export function migrateGuardianActionTables(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  try {
    raw.exec('BEGIN');

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS guardian_action_requests (
        id TEXT PRIMARY KEY,
        assistant_id TEXT NOT NULL DEFAULT 'self',
        kind TEXT NOT NULL,
        source_channel TEXT NOT NULL,
        source_conversation_id TEXT NOT NULL,
        call_session_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
        pending_question_id TEXT NOT NULL REFERENCES call_pending_questions(id) ON DELETE CASCADE,
        question_text TEXT NOT NULL,
        request_code TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        answer_text TEXT,
        answered_by_channel TEXT,
        answered_by_external_user_id TEXT,
        answered_at INTEGER,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS guardian_action_deliveries (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES guardian_action_requests(id) ON DELETE CASCADE,
        destination_channel TEXT NOT NULL,
        destination_conversation_id TEXT,
        destination_chat_id TEXT,
        destination_external_user_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        sent_at INTEGER,
        responded_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_requests_status ON guardian_action_requests(status)`);
    raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_requests_call_session ON guardian_action_requests(call_session_id)`);
    raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_requests_pending_question ON guardian_action_requests(pending_question_id)`);
    raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_requests_request_code ON guardian_action_requests(request_code)`);
    raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_deliveries_request_id ON guardian_action_deliveries(request_id)`);
    raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_deliveries_status ON guardian_action_deliveries(status)`);
    raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_deliveries_destination ON guardian_action_deliveries(destination_channel, destination_chat_id)`);

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}
