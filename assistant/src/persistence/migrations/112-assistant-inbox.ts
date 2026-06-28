import type { DrizzleDb } from "../db-connection.js";
import { migrateBackfillInboxThreadStateFromBindings } from "./014-backfill-inbox-thread-state.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Assistant inbox tables: ingress invites, ingress members, inbox thread state.
 */
export function createAssistantInboxTables(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS assistant_ingress_invites (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL DEFAULT 'self',
      source_channel TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      created_by_session_id TEXT,
      note TEXT,
      max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
      use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      redeemed_by_external_user_id TEXT,
      redeemed_by_external_chat_id TEXT,
      redeemed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_ingress_invites_token_hash ON assistant_ingress_invites(token_hash)`,
  );
  if (tableHasColumn(database, "assistant_ingress_invites", "assistant_id")) {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_ingress_invites_channel_status ON assistant_ingress_invites(assistant_id, source_channel, status, expires_at)`,
    );
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_ingress_invites_channel_created ON assistant_ingress_invites(assistant_id, source_channel, created_at)`,
    );
  } else {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_ingress_invites_channel_status ON assistant_ingress_invites(source_channel, status, expires_at)`,
    );
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_ingress_invites_channel_created ON assistant_ingress_invites(source_channel, created_at)`,
    );
  }

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS assistant_ingress_members (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL DEFAULT 'self',
      source_channel TEXT NOT NULL,
      external_user_id TEXT,
      external_chat_id TEXT,
      display_name TEXT,
      username TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      policy TEXT NOT NULL DEFAULT 'allow',
      invite_id TEXT REFERENCES assistant_ingress_invites(id) ON DELETE CASCADE,
      created_by_session_id TEXT,
      revoked_reason TEXT,
      blocked_reason TEXT,
      last_seen_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (external_user_id IS NOT NULL OR external_chat_id IS NOT NULL)
    )
  `);

  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_ingress_members_user ON assistant_ingress_members(assistant_id, source_channel, external_user_id) WHERE external_user_id IS NOT NULL`,
  );
  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_ingress_members_chat ON assistant_ingress_members(assistant_id, source_channel, external_chat_id) WHERE external_chat_id IS NOT NULL`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_ingress_members_status_policy ON assistant_ingress_members(assistant_id, source_channel, status, policy)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_ingress_members_updated ON assistant_ingress_members(assistant_id, source_channel, updated_at)`,
  );

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS assistant_inbox_thread_state (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      assistant_id TEXT NOT NULL DEFAULT 'self',
      source_channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      external_user_id TEXT,
      display_name TEXT,
      username TEXT,
      last_inbound_at INTEGER,
      last_outbound_at INTEGER,
      last_message_at INTEGER,
      unread_count INTEGER NOT NULL DEFAULT 0,
      pending_escalation_count INTEGER NOT NULL DEFAULT 0,
      has_pending_escalation INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  if (
    tableHasColumn(database, "assistant_inbox_thread_state", "assistant_id")
  ) {
    database.run(
      /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_thread_state_channel ON assistant_inbox_thread_state(assistant_id, source_channel, external_chat_id)`,
    );
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_inbox_thread_state_last_msg ON assistant_inbox_thread_state(assistant_id, last_message_at)`,
    );
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_inbox_thread_state_escalation ON assistant_inbox_thread_state(assistant_id, has_pending_escalation, last_message_at)`,
    );
  } else {
    database.run(
      /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_thread_state_channel ON assistant_inbox_thread_state(source_channel, external_chat_id)`,
    );
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_inbox_thread_state_last_msg ON assistant_inbox_thread_state(last_message_at)`,
    );
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_inbox_thread_state_escalation ON assistant_inbox_thread_state(has_pending_escalation, last_message_at)`,
    );
  }

  migrateBackfillInboxThreadStateFromBindings(database);
}
