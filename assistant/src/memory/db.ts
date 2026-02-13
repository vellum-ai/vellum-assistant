import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema.js';
import { getDbPath, ensureDataDir } from '../util/platform.js';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!db) {
    ensureDataDir();
    const sqlite = new Database(getDbPath());
    sqlite.exec('PRAGMA journal_mode=WAL');
    sqlite.exec('PRAGMA foreign_keys = ON');
    db = drizzle(sqlite, { schema });
  }
  return db;
}

/** Reset the db singleton. Used by tests to ensure isolation between test files. */
export function resetDb(): void {
  if (db) {
    const raw = (db as unknown as { $client: Database }).$client;
    raw.close();
    db = null;
  }
}

export function initializeDb(): void {
  const database = getDb();

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_estimated_cost REAL NOT NULL DEFAULT 0,
      context_summary TEXT,
      context_compacted_message_count INTEGER NOT NULL DEFAULT 0,
      context_compacted_at INTEGER
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS tool_invocations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      result TEXT NOT NULL,
      decision TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_segments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      statement TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_used_at INTEGER
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_item_sources (
      memory_item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      evidence TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (memory_item_id, message_id)
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_summaries (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      summary TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (scope, scope_key)
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (target_type, target_id, provider, model)
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      run_after INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      kind TEXT NOT NULL,
      data_base64 TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS channel_inbound_events (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (assistant_id, source_channel, external_chat_id, external_message_id)
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS message_runs (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running',
      pending_confirmation TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      cron_expression TEXT NOT NULL,
      timezone TEXT,
      message TEXT NOT NULL,
      next_run_at INTEGER NOT NULL,
      last_run_at INTEGER,
      last_status TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS cron_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      duration_ms INTEGER,
      output TEXT,
      error TEXT,
      conversation_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      username TEXT,
      email TEXT,
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      credential_ref TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS llm_usage_events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      assistant_id TEXT,
      conversation_id TEXT,
      run_id TEXT,
      request_id TEXT,
      actor TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      estimated_cost_usd REAL,
      pricing_status TEXT NOT NULL,
      metadata_json TEXT
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      aliases TEXT,
      description TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      mention_count INTEGER NOT NULL DEFAULT 1
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_entity_relations (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      evidence TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_item_entities (
      memory_item_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      PRIMARY KEY (memory_item_id, entity_id)
    )
  `);

  // FTS table for lexical retrieval over memory_segments.text.
  database.run(/*sql*/ `
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_segment_fts USING fts5(
      segment_id UNINDEXED,
      text
    )
  `);

  database.run(/*sql*/ `
    CREATE TRIGGER IF NOT EXISTS memory_segments_ai
    AFTER INSERT ON memory_segments
    BEGIN
      INSERT INTO memory_segment_fts(segment_id, text) VALUES (new.id, new.text);
    END
  `);

  database.run(/*sql*/ `
    CREATE TRIGGER IF NOT EXISTS memory_segments_ad
    AFTER DELETE ON memory_segments
    BEGIN
      DELETE FROM memory_segment_fts WHERE segment_id = old.id;
    END
  `);

  database.run(/*sql*/ `
    CREATE TRIGGER IF NOT EXISTS memory_segments_au
    AFTER UPDATE ON memory_segments
    BEGIN
      DELETE FROM memory_segment_fts WHERE segment_id = old.id;
      INSERT INTO memory_segment_fts(segment_id, text) VALUES (new.id, new.text);
    END
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS conversation_keys (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE (assistant_id, conversation_key)
    )
  `);

  // Migrations — ALTER TABLE ADD COLUMN throws if column already exists
  try { database.run(/*sql*/ `ALTER TABLE conversations ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE conversations ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE conversations ADD COLUMN total_estimated_cost REAL NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE conversations ADD COLUMN context_summary TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE conversations ADD COLUMN context_compacted_message_count INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE conversations ADD COLUMN context_compacted_at INTEGER`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE memory_items ADD COLUMN importance REAL`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE memory_items ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE memory_summaries ADD COLUMN version INTEGER NOT NULL DEFAULT 1`); } catch { /* already exists */ }

  migrateToolInvocationsFk(database);

  // Indexes for query performance on large datasets
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_tool_invocations_conversation_id ON tool_invocations(conversation_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)`);
  database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_segments_message_segment ON memory_segments(message_id, segment_index)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_segments_conversation_created ON memory_segments(conversation_id, created_at DESC)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_sources_message_id ON memory_item_sources(message_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_kind_status ON memory_items(kind, status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_target ON memory_embeddings(target_type, target_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_provider_model ON memory_embeddings(provider, model)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_run_after ON memory_jobs(status, run_after)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_summaries_scope_time ON memory_summaries(scope, end_at DESC)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversation_keys_assistant_key ON conversation_keys(assistant_id, conversation_key)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_attachments_assistant_id ON attachments(assistant_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments(message_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_message_attachments_attachment_id ON message_attachments(attachment_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_inbound_events_lookup ON channel_inbound_events(assistant_id, source_channel, external_chat_id, external_message_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_inbound_events_conversation ON channel_inbound_events(conversation_id)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_message_runs_assistant_status ON message_runs(assistant_id, status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_message_runs_conversation ON message_runs(conversation_id)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled_next_run ON cron_jobs(enabled, next_run_at)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_cron_runs_job_id ON cron_runs(job_id)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_accounts_service ON accounts(service)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_created_at ON llm_usage_events(created_at)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_assistant_id ON llm_usage_events(assistant_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_provider ON llm_usage_events(provider)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_model ON llm_usage_events(model)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_actor ON llm_usage_events(actor)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_entities_name ON memory_entities(name)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_entities_type ON memory_entities(type)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_entity_relations_source ON memory_entity_relations(source_entity_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_entity_relations_target ON memory_entity_relations(target_entity_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_entities_memory_item ON memory_item_entities(memory_item_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_entities_entity ON memory_item_entities(entity_id)`);

  migrateMemoryFtsBackfill(database);
}

/**
 * Migrate existing tool_invocations table to add FK constraint with ON DELETE CASCADE.
 * SQLite doesn't support ALTER TABLE ADD CONSTRAINT, so we rebuild the table.
 * This is idempotent: it checks whether the FK already exists before migrating.
 */
function migrateToolInvocationsFk(database: ReturnType<typeof drizzle<typeof schema>>): void {
  const raw = (database as unknown as { $client: Database }).$client;
  const row = raw.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_invocations'`).get() as { sql: string } | null;
  if (!row) return; // table doesn't exist yet (will be created above)

  // If the DDL already contains REFERENCES, the FK is in place
  if (row.sql.includes('REFERENCES')) return;

  raw.exec('PRAGMA foreign_keys = OFF');
  try {
    raw.exec(/*sql*/ `
      BEGIN;
      CREATE TABLE tool_invocations_new (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        result TEXT NOT NULL,
        decision TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO tool_invocations_new SELECT t.* FROM tool_invocations t
        WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id);
      DROP TABLE tool_invocations;
      ALTER TABLE tool_invocations_new RENAME TO tool_invocations;
      COMMIT;
    `);
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  } finally {
    raw.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Backfill FTS rows for existing memory_segments records when upgrading from a
 * version that may not have had trigger-managed FTS.
 */
function migrateMemoryFtsBackfill(database: ReturnType<typeof drizzle<typeof schema>>): void {
  const raw = (database as unknown as { $client: Database }).$client;
  const ftsCountRow = raw.query(`SELECT COUNT(*) AS c FROM memory_segment_fts`).get() as { c: number } | null;
  const ftsCount = ftsCountRow?.c ?? 0;
  if (ftsCount > 0) return;

  raw.exec(/*sql*/ `
    INSERT INTO memory_segment_fts(segment_id, text)
    SELECT id, text FROM memory_segments
  `);
}
