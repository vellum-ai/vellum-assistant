import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Channel guardian tables: bindings, verification challenges, approval requests,
 * and rate limits with indexes.
 */
export function createChannelGuardianTables(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS channel_guardian_bindings (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      guardian_external_user_id TEXT NOT NULL,
      guardian_delivery_chat_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      verified_at INTEGER NOT NULL,
      verified_via TEXT NOT NULL DEFAULT 'challenge',
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_guardian_bindings_active
    ON channel_guardian_bindings(assistant_id, channel)
    WHERE status = 'active'
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS channel_guardian_verification_challenges (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      challenge_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_by_session_id TEXT,
      consumed_by_external_user_id TEXT,
      consumed_by_chat_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  if (
    tableHasColumn(
      database,
      "channel_guardian_verification_challenges",
      "assistant_id",
    )
  ) {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_guardian_challenges_lookup ON channel_guardian_verification_challenges(assistant_id, channel, challenge_hash, status)`,
    );
  } else {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_guardian_challenges_lookup ON channel_guardian_verification_challenges(channel, challenge_hash, status)`,
    );
  }

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS channel_guardian_approval_requests (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      requester_external_user_id TEXT NOT NULL,
      requester_chat_id TEXT NOT NULL,
      guardian_external_user_id TEXT NOT NULL,
      guardian_chat_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      risk_level TEXT,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by_external_user_id TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_guardian_approval_run ON channel_guardian_approval_requests(run_id, status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_guardian_approval_status ON channel_guardian_approval_requests(status)`,
  );

  // Migration: add assistant_id column to scope approval requests by assistant.
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_approval_requests ADD COLUMN assistant_id TEXT NOT NULL DEFAULT 'self'`,
    );
  } catch {
    /* already exists */
  }

  // Migration: add request_id column for pending-interactions lookup (replaces run_id).
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_approval_requests ADD COLUMN request_id TEXT`,
    );
  } catch {
    /* already exists */
  }

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS channel_guardian_rate_limits (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      actor_external_user_id TEXT NOT NULL,
      actor_chat_id TEXT NOT NULL,
      invalid_attempts INTEGER NOT NULL DEFAULT 0,
      window_started_at INTEGER NOT NULL DEFAULT 0,
      attempt_timestamps_json TEXT NOT NULL DEFAULT '[]',
      locked_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Migration: add attempt_timestamps_json column for true sliding-window rate limiting.
  // The old invalid_attempts / window_started_at columns are left in place (SQLite
  // doesn't support DROP COLUMN in older versions) but are no longer read by the app.
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_rate_limits ADD COLUMN attempt_timestamps_json TEXT NOT NULL DEFAULT '[]'`,
    );
  } catch {
    /* already exists */
  }

  // Migration: re-add legacy columns for databases created during the brief window when
  // PR #6748 was live (columns were absent from CREATE TABLE). These columns are not read
  // by app logic but must exist so drizzle inserts don't fail.
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_rate_limits ADD COLUMN invalid_attempts INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_rate_limits ADD COLUMN window_started_at INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }

  if (
    tableHasColumn(database, "channel_guardian_rate_limits", "assistant_id")
  ) {
    database.run(
      /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_guardian_rate_limits_actor ON channel_guardian_rate_limits(assistant_id, channel, actor_external_user_id, actor_chat_id)`,
    );
  } else {
    database.run(
      /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_guardian_rate_limits_actor ON channel_guardian_rate_limits(channel, actor_external_user_id, actor_chat_id)`,
    );
  }
}
