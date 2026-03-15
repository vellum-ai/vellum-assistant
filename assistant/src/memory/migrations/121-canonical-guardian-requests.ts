import type { DrizzleDb } from "../db-connection.js";

/**
 * Create canonical_guardian_requests and canonical_guardian_deliveries tables.
 *
 * These tables unify the split voice (guardian_action_requests / guardian_action_deliveries)
 * and channel (channel_guardian_approval_requests) persistence models into a single
 * canonical domain. Uses CREATE TABLE IF NOT EXISTS for idempotency.
 */
export function createCanonicalGuardianTables(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS canonical_guardian_requests (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_channel TEXT,
      conversation_id TEXT,
      requester_external_user_id TEXT,
      guardian_external_user_id TEXT,
      call_session_id TEXT,
      pending_question_id TEXT,
      question_text TEXT,
      request_code TEXT,
      tool_name TEXT,
      input_digest TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      answer_text TEXT,
      decided_by_external_user_id TEXT,
      followup_state TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_status ON canonical_guardian_requests(status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_guardian ON canonical_guardian_requests(guardian_external_user_id, status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_conversation ON canonical_guardian_requests(conversation_id, status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_source ON canonical_guardian_requests(source_type, status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_kind ON canonical_guardian_requests(kind, status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_request_code ON canonical_guardian_requests(request_code)`,
  );

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS canonical_guardian_deliveries (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES canonical_guardian_requests(id) ON DELETE CASCADE,
      destination_channel TEXT NOT NULL,
      destination_conversation_id TEXT,
      destination_chat_id TEXT,
      destination_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_deliveries_request_id ON canonical_guardian_deliveries(request_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_deliveries_status ON canonical_guardian_deliveries(status)`,
  );
}
