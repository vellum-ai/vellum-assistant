import { type DrizzleDb, getSqliteFrom } from '../db-connection.js';

/**
 * Rebuild messages, task_runs, and assistant_ingress_members tables to add
 * ON DELETE CASCADE to their FK constraints.  SQLite does not support
 * ALTER TABLE to change FK behavior, so a table rebuild is required.
 *
 * Follows the same pattern as 002-tool-invocations-fk.ts: check if the
 * DDL already contains ON DELETE CASCADE, and skip if so.
 */
export function migrateFkCascadeRebuilds(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  rebuildMessages(raw);
  rebuildTaskRuns(raw);
  rebuildAssistantIngressMembers(raw);
}

function hasCascade(raw: ReturnType<typeof getSqliteFrom>, tableName: string): boolean {
  const row = raw.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(tableName) as { sql: string } | null;
  if (!row) return true; // table doesn't exist yet — will be created with correct DDL
  return row.sql.includes('ON DELETE CASCADE');
}

function rebuildMessages(raw: ReturnType<typeof getSqliteFrom>): void {
  if (hasCascade(raw, 'messages')) return;

  raw.exec('PRAGMA foreign_keys = OFF');
  try {
    raw.exec(/*sql*/ `
      BEGIN;

      DROP TRIGGER IF EXISTS messages_fts_ai;
      DROP TRIGGER IF EXISTS messages_fts_ad;
      DROP TRIGGER IF EXISTS messages_fts_au;

      CREATE TABLE messages_new (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        metadata TEXT
      );
      INSERT INTO messages_new SELECT id, conversation_id, role, content, created_at, metadata FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;

      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

      CREATE TRIGGER IF NOT EXISTS messages_fts_ai
      AFTER INSERT ON messages
      BEGIN
        INSERT INTO messages_fts(message_id, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_ad
      AFTER DELETE ON messages
      BEGIN
        DELETE FROM messages_fts WHERE message_id = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_au
      AFTER UPDATE ON messages
      BEGIN
        DELETE FROM messages_fts WHERE message_id = old.id;
        INSERT INTO messages_fts(message_id, content) VALUES (new.id, new.content);
      END;

      COMMIT;
    `);
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  } finally {
    raw.exec('PRAGMA foreign_keys = ON');
  }
}

function rebuildTaskRuns(raw: ReturnType<typeof getSqliteFrom>): void {
  if (hasCascade(raw, 'task_runs')) return;

  raw.exec('PRAGMA foreign_keys = OFF');
  try {
    raw.exec(/*sql*/ `
      BEGIN;
      CREATE TABLE task_runs_new (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        conversation_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at INTEGER,
        finished_at INTEGER,
        error TEXT,
        principal_id TEXT,
        memory_scope_id TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO task_runs_new SELECT id, task_id, conversation_id, status, started_at, finished_at, error, principal_id, memory_scope_id, created_at FROM task_runs;
      DROP TABLE task_runs;
      ALTER TABLE task_runs_new RENAME TO task_runs;

      CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
      CREATE INDEX IF NOT EXISTS idx_task_runs_conversation_status ON task_runs(conversation_id, status);

      COMMIT;
    `);
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  } finally {
    raw.exec('PRAGMA foreign_keys = ON');
  }
}

function rebuildAssistantIngressMembers(raw: ReturnType<typeof getSqliteFrom>): void {
  if (hasCascade(raw, 'assistant_ingress_members')) return;

  raw.exec('PRAGMA foreign_keys = OFF');
  try {
    raw.exec(/*sql*/ `
      BEGIN;
      CREATE TABLE assistant_ingress_members_new (
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
      );
      INSERT INTO assistant_ingress_members_new SELECT id, assistant_id, source_channel, external_user_id, external_chat_id, display_name, username, status, policy, invite_id, created_by_session_id, revoked_reason, blocked_reason, last_seen_at, created_at, updated_at FROM assistant_ingress_members;
      DROP TABLE assistant_ingress_members;
      ALTER TABLE assistant_ingress_members_new RENAME TO assistant_ingress_members;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_ingress_members_user ON assistant_ingress_members(assistant_id, source_channel, external_user_id) WHERE external_user_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ingress_members_chat ON assistant_ingress_members(assistant_id, source_channel, external_chat_id) WHERE external_chat_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_ingress_members_status_policy ON assistant_ingress_members(assistant_id, source_channel, status, policy);
      CREATE INDEX IF NOT EXISTS idx_ingress_members_updated ON assistant_ingress_members(assistant_id, source_channel, updated_at);

      COMMIT;
    `);
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  } finally {
    raw.exec('PRAGMA foreign_keys = ON');
  }
}
