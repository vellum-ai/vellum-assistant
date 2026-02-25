import type { DrizzleDb } from '../db-connection.js';
import { migrateCallSessionsProviderSidDedup } from './011-call-sessions-provider-sid-dedup.js';
import { migrateCallSessionsAddInitiatedFrom } from './012-call-sessions-add-initiated-from.js';

/**
 * Call sessions, call events, call pending questions, processed callbacks,
 * plus related ALTER TABLE migrations and indexes.
 */
export function createCallSessionsTables(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS call_sessions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_call_sid TEXT,
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      task TEXT,
      status TEXT NOT NULL DEFAULT 'initiated',
      started_at INTEGER,
      ended_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS call_events (
      id TEXT PRIMARY KEY,
      call_session_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS call_pending_questions (
      id TEXT PRIMARY KEY,
      call_session_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
      question_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      asked_at INTEGER NOT NULL,
      answered_at INTEGER,
      answer_text TEXT
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS processed_callbacks (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      call_session_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_call_sessions_conversation_id ON call_sessions(conversation_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_call_sessions_provider_call_sid ON call_sessions(provider_call_sid)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_call_sessions_status ON call_sessions(status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_call_events_call_session_id ON call_events(call_session_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_call_pending_questions_call_session_id ON call_pending_questions(call_session_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_call_pending_questions_status ON call_pending_questions(status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_processed_callbacks_dedupe_key ON processed_callbacks(dedupe_key)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_processed_callbacks_call_session_id ON processed_callbacks(call_session_id)`);

  // Add claim ownership token to prevent cross-handler claim interference
  try { database.run(/*sql*/ `ALTER TABLE processed_callbacks ADD COLUMN claim_id TEXT`); } catch { /* already exists */ }

  // Caller identity persistence for auditability
  try { database.run(/*sql*/ `ALTER TABLE call_sessions ADD COLUMN caller_identity_mode TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE call_sessions ADD COLUMN caller_identity_source TEXT`); } catch { /* already exists */ }

  // Persist assistantId so the webhook path can resolve assistant-scoped Twilio numbers
  try { database.run(/*sql*/ `ALTER TABLE call_sessions ADD COLUMN assistant_id TEXT`); } catch { /* already exists */ }

  // Track which conversation initiated the call (the chat where call_start was invoked)
  migrateCallSessionsAddInitiatedFrom(database);

  // Unique constraint: at most one non-null provider_call_sid per (provider, provider_call_sid).
  // On upgraded databases that pre-date this constraint, duplicate rows may exist; deduplicate
  // them first to avoid a UNIQUE constraint failure that would prevent startup.
  migrateCallSessionsProviderSidDedup(database);
  database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_call_sessions_provider_sid_unique ON call_sessions(provider, provider_call_sid) WHERE provider_call_sid IS NOT NULL`);
}
