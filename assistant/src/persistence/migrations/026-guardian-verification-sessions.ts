import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Extend channel_guardian_verification_challenges with outbound verification
 * session fields: expected-identity binding, delivery tracking, and session
 * state machine columns.
 */
export function migrateGuardianVerificationSessions(database: DrizzleDb): void {
  // -- New columns for expected-identity binding --
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_verification_challenges ADD COLUMN expected_external_user_id TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_verification_challenges ADD COLUMN expected_chat_id TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_verification_challenges ADD COLUMN expected_phone_e164 TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_verification_challenges ADD COLUMN identity_binding_status TEXT DEFAULT 'bound'`,
    );
  } catch {
    /* already exists */
  }

  // -- Outbound delivery tracking --
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_verification_challenges ADD COLUMN destination_address TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_verification_challenges ADD COLUMN last_sent_at INTEGER`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_verification_challenges ADD COLUMN send_count INTEGER DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_verification_challenges ADD COLUMN next_resend_at INTEGER`,
    );
  } catch {
    /* already exists */
  }

  // -- Session configuration --
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_verification_challenges ADD COLUMN code_digits INTEGER DEFAULT 6`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_verification_challenges ADD COLUMN max_attempts INTEGER DEFAULT 3`,
    );
  } catch {
    /* already exists */
  }

  // -- Indexes for session lookups --
  if (
    tableHasColumn(
      database,
      "channel_guardian_verification_challenges",
      "assistant_id",
    )
  ) {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_active ON channel_guardian_verification_challenges(assistant_id, channel, status)`,
    );
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_identity ON channel_guardian_verification_challenges(assistant_id, channel, expected_external_user_id, expected_chat_id, status)`,
    );
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_destination ON channel_guardian_verification_challenges(assistant_id, channel, destination_address)`,
    );
  } else {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_active ON channel_guardian_verification_challenges(channel, status)`,
    );
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_identity ON channel_guardian_verification_challenges(channel, expected_external_user_id, expected_chat_id, status)`,
    );
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_destination ON channel_guardian_verification_challenges(channel, destination_address)`,
    );
  }
}
