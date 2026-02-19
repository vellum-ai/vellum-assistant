import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { computeMemoryFingerprint } from './fingerprint.js';
import * as schema from './schema.js';
import { getDbPath, ensureDataDir, migrateToDataLayout, migrateToWorkspaceLayout } from '../util/platform.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('memory-db');

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!db) {
    migrateToDataLayout();
    migrateToWorkspaceLayout();
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
      fingerprint TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS memory_item_conflicts (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL DEFAULT 'default',
      existing_item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
      candidate_item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
      relationship TEXT NOT NULL,
      status TEXT NOT NULL,
      clarification_question TEXT,
      resolution_note TEXT,
      last_asked_at INTEGER,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
    CREATE TABLE IF NOT EXISTS message_surfaces (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      surface_id TEXT NOT NULL,
      surface_type TEXT NOT NULL,
      title TEXT,
      data TEXT NOT NULL,
      actions TEXT,
      surface_message TEXT,
      display TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS channel_inbound_events (
      id TEXT PRIMARY KEY,
      source_channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (source_channel, external_chat_id, external_message_id)
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS message_runs (
      id TEXT PRIMARY KEY,
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
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      message TEXT NOT NULL,
      fire_at INTEGER NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      fired_at INTEGER,
      conversation_id TEXT,
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
    CREATE TABLE IF NOT EXISTS documents (
      surface_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS published_pages (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL UNIQUE,
      public_url TEXT NOT NULL,
      page_title TEXT,
      html_hash TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);

  try { database.run(/*sql*/ `ALTER TABLE published_pages ADD COLUMN app_id TEXT`); } catch (e) { log.debug({ err: e }, 'ALTER TABLE published_pages ADD COLUMN app_id (likely already exists)'); }
  try { database.run(/*sql*/ `ALTER TABLE published_pages ADD COLUMN project_slug TEXT`); } catch (e) { log.debug({ err: e }, 'ALTER TABLE published_pages ADD COLUMN project_slug (likely already exists)'); }

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS shared_app_links (
      id TEXT PRIMARY KEY,
      share_token TEXT NOT NULL UNIQUE,
      bundle_data BLOB NOT NULL,
      bundle_size_bytes INTEGER NOT NULL,
      manifest_json TEXT NOT NULL,
      download_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS home_base_app_links (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // ── Watchers ─────────────────────────────────────────────────────────

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS watchers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      poll_interval_ms INTEGER NOT NULL DEFAULT 60000,
      action_prompt TEXT NOT NULL,
      watermark TEXT,
      conversation_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      consecutive_errors INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_poll_at INTEGER,
      next_poll_at INTEGER NOT NULL,
      config_json TEXT,
      credential_service TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS watcher_events (
      id TEXT PRIMARY KEY,
      watcher_id TEXT NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      disposition TEXT NOT NULL DEFAULT 'pending',
      llm_action TEXT,
      processed_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (watcher_id, external_id)
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS llm_request_logs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      request_payload TEXT NOT NULL,
      response_payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
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
      conversation_key TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
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
  try { database.run(/*sql*/ `ALTER TABLE memory_items ADD COLUMN valid_from INTEGER`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE memory_items ADD COLUMN invalid_at INTEGER`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE memory_items ADD COLUMN verification_state TEXT NOT NULL DEFAULT 'assistant_inferred'`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE memory_jobs ADD COLUMN deferrals INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE memory_segments ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'default'`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE memory_items ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'default'`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE memory_summaries ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'default'`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE memory_segments ADD COLUMN content_hash TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE channel_inbound_events ADD COLUMN source_message_id TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE attachments ADD COLUMN content_hash TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE channel_inbound_events ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'pending'`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE channel_inbound_events ADD COLUMN processing_attempts INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE channel_inbound_events ADD COLUMN last_processing_error TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE channel_inbound_events ADD COLUMN retry_after INTEGER`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE channel_inbound_events ADD COLUMN raw_payload TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE conversations ADD COLUMN thread_type TEXT NOT NULL DEFAULT 'standard'`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE conversations ADD COLUMN memory_scope_id TEXT NOT NULL DEFAULT 'default'`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE attachments ADD COLUMN thumbnail_base64 TEXT`); } catch { /* already exists */ }

  migrateJobDeferrals(database);
  migrateToolInvocationsFk(database);
  migrateMemoryEntityRelationDedup(database);
  migrateMemoryItemsFingerprintScopeUnique(database);
  migrateMemoryItemsScopeSaltedFingerprints(database);
  migrateAssistantIdToSelf(database);
  migrateRemoveAssistantIdColumns(database);

  // Indexes for query performance on large datasets
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_request_logs_conv_created ON llm_request_logs(conversation_id, created_at)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_tool_invocations_conversation_id ON tool_invocations(conversation_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)`);
  database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_segments_message_segment ON memory_segments(message_id, segment_index)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_segments_conversation_created ON memory_segments(conversation_id, created_at DESC)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_sources_message_id ON memory_item_sources(message_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_conflicts_status_created ON memory_item_conflicts(status, created_at)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_conflicts_status_resolved_at ON memory_item_conflicts(status, resolved_at)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_conflicts_scope_status ON memory_item_conflicts(scope_id, status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_conflicts_existing_item_id ON memory_item_conflicts(existing_item_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_conflicts_candidate_item_id ON memory_item_conflicts(candidate_item_id)`);
  database.run(/*sql*/ `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_item_conflicts_pending_pair_unique
    ON memory_item_conflicts(scope_id, existing_item_id, candidate_item_id)
    WHERE status = 'pending_clarification'
  `);
  database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_fingerprint_scope ON memory_items(fingerprint, scope_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_kind_status ON memory_items(kind, status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_status_invalid_at ON memory_items(status, invalid_at)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_scope_status_kind ON memory_items(scope_id, status, kind)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_last_seen_at ON memory_items(last_seen_at)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_target ON memory_embeddings(target_type, target_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_provider_model ON memory_embeddings(provider, model)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_run_after ON memory_jobs(status, run_after)`);
  database.run(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_jobs_conflict_resolve_dedupe
    ON memory_jobs(
      type,
      status,
      json_extract(payload, '$.messageId'),
      COALESCE(json_extract(payload, '$.scopeId'), 'default')
    )
  `);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_summaries_scope_time ON memory_summaries(scope, end_at DESC)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_segments_scope_id ON memory_segments(scope_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_scope_id ON memory_items(scope_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_summaries_scope_id ON memory_summaries(scope_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversation_keys_key ON conversation_keys(conversation_key)`);
  database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_content_dedup ON attachments(content_hash) WHERE content_hash IS NOT NULL`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments(message_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_message_attachments_attachment_id ON message_attachments(attachment_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_inbound_events_lookup ON channel_inbound_events(source_channel, external_chat_id, external_message_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_inbound_events_conversation ON channel_inbound_events(conversation_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_inbound_events_source_msg ON channel_inbound_events(source_channel, external_chat_id, source_message_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_inbound_events_processing_retry ON channel_inbound_events(processing_status, retry_after)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_message_runs_status ON message_runs(status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_message_runs_conversation ON message_runs(conversation_id)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_reminders_status_fire_at ON reminders(status, fire_at)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled_next_run ON cron_jobs(enabled, next_run_at)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_cron_runs_job_id ON cron_runs(job_id)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_accounts_service ON accounts(service)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_created_at ON llm_usage_events(created_at)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_assistant_id ON llm_usage_events(assistant_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_provider ON llm_usage_events(provider)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_model ON llm_usage_events(model)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_actor ON llm_usage_events(actor)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_shared_app_links_share_token ON shared_app_links(share_token)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_home_base_app_links_app_id ON home_base_app_links(app_id)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_published_pages_html_hash ON published_pages(html_hash)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_published_pages_status ON published_pages(status)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_watchers_enabled_next_poll ON watchers(enabled, next_poll_at)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_watchers_status ON watchers(status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_watcher_events_watcher_id ON watcher_events(watcher_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_watcher_events_disposition ON watcher_events(disposition)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_entities_name ON memory_entities(name)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_entities_type ON memory_entities(type)`);
  database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entity_relations_unique_edge ON memory_entity_relations(source_entity_id, target_entity_id, relation)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_entity_relations_source ON memory_entity_relations(source_entity_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_entity_relations_target ON memory_entity_relations(target_entity_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_entities_memory_item ON memory_item_entities(memory_item_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_entities_entity ON memory_item_entities(entity_id)`);

  // ── Contacts ────────────────────────────────────────────────────────

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      relationship TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      response_expectation TEXT,
      preferred_tone TEXT,
      last_interaction INTEGER,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS contact_channels (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      address TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_contacts_display_name ON contacts(display_name)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_contacts_importance ON contacts(importance DESC)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_contacts_last_interaction ON contacts(last_interaction DESC)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_contact_channels_contact_id ON contact_channels(contact_id)`);
  database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_channels_type_address ON contact_channels(type, address)`);

  // ── Triage Results ─────────────────────────────────────────────────

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS triage_results (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      sender TEXT NOT NULL,
      category TEXT NOT NULL,
      confidence REAL NOT NULL,
      suggested_action TEXT NOT NULL,
      matched_playbook_ids TEXT,
      message_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_triage_results_channel ON triage_results(channel)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_triage_results_category ON triage_results(category)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_triage_results_sender ON triage_results(sender)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_triage_results_created_at ON triage_results(created_at DESC)`);

  // ── Call Sessions (outgoing AI phone calls) ────────────────────────

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

  // Unique constraint: at most one non-null provider_call_sid per (provider, provider_call_sid).
  // On upgraded databases that pre-date this constraint, duplicate rows may exist; deduplicate
  // them first to avoid a UNIQUE constraint failure that would prevent startup.
  migrateCallSessionsProviderSidDedup(database);
  database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_call_sessions_provider_sid_unique ON call_sessions(provider, provider_call_sid) WHERE provider_call_sid IS NOT NULL`);

  // ── Follow-ups ─────────────────────────────────────────────────────

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

  // ── Tasks ─────────────────────────────────────────────────────────

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      template TEXT NOT NULL,
      input_schema TEXT,
      context_flags TEXT,
      required_tools TEXT,
      created_from_conversation_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      conversation_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at INTEGER,
      finished_at INTEGER,
      error TEXT,
      principal_id TEXT,
      memory_scope_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS task_candidates (
      id TEXT PRIMARY KEY,
      source_conversation_id TEXT NOT NULL,
      compiled_template TEXT NOT NULL,
      confidence REAL,
      required_tools TEXT,
      created_at INTEGER NOT NULL,
      promoted_task_id TEXT
    )
  `);

  // ── Work Items (Tasks) ──────────────────────────────────────────────

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      title TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      priority_tier INTEGER NOT NULL DEFAULT 1,
      sort_index INTEGER,
      last_run_id TEXT,
      last_run_conversation_id TEXT,
      last_run_status TEXT,
      source_type TEXT,
      source_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Work item permission preflight columns
  try { database.run(/*sql*/ `ALTER TABLE work_items ADD COLUMN approved_tools TEXT`); } catch (e) { log.debug({ err: e }, 'ALTER TABLE work_items ADD COLUMN approved_tools (likely already exists)'); }
  try { database.run(/*sql*/ `ALTER TABLE work_items ADD COLUMN approval_status TEXT DEFAULT 'none'`); } catch (e) { log.debug({ err: e }, 'ALTER TABLE work_items ADD COLUMN approval_status (likely already exists)'); }

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_work_items_task_id ON work_items(task_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_work_items_priority_sort ON work_items(priority_tier, sort_index)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_task_candidates_promoted ON task_candidates(promoted_task_id)`);

  migrateMemoryFtsBackfill(database);
}

/**
 * One-shot migration: reconcile old deferral history into the new `deferrals` column.
 *
 * Before the `deferrals` column was added, `deferMemoryJob` incremented `attempts`.
 * After the column is added with DEFAULT 0, those legacy jobs still carry the old
 * attempt count (which was really a deferral count) while `deferrals` is 0. This
 * moves the attempt count into `deferrals` and resets `attempts` to 0.
 *
 * This migration MUST run only once. On subsequent startups, post-migration jobs
 * that genuinely failed via `failMemoryJob` (attempts > 0, deferrals = 0, non-null
 * last_error) must NOT be touched — resetting their attempts would let them bypass
 * the configured maxAttempts budget across restarts.
 *
 * We use a `memory_checkpoints` row to ensure the migration runs exactly once.
 */
function migrateJobDeferrals(database: ReturnType<typeof drizzle<typeof schema>>): void {
  const raw = (database as unknown as { $client: Database }).$client;
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = 'migration_job_deferrals'`
  ).get();
  if (checkpoint) return;

  try {
    raw.exec(/*sql*/ `
      BEGIN;
      UPDATE memory_jobs
      SET deferrals = attempts,
          attempts = 0,
          last_error = NULL,
          updated_at = ${Date.now()}
      WHERE status = 'pending'
        AND attempts > 0
        AND deferrals = 0
        AND type IN ('embed_segment', 'embed_item', 'embed_summary');
      INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at)
      VALUES ('migration_job_deferrals', '1', ${Date.now()});
      COMMIT;
    `);
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
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

/**
 * One-shot migration: merge duplicate relation edges so uniqueness can be
 * enforced on (source_entity_id, target_entity_id, relation).
 */
function migrateMemoryEntityRelationDedup(database: ReturnType<typeof drizzle<typeof schema>>): void {
  const raw = (database as unknown as { $client: Database }).$client;
  const checkpointKey = 'migration_memory_entity_relations_dedup_v1';
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = ?`,
  ).get(checkpointKey);
  if (checkpoint) return;

  try {
    raw.exec('BEGIN');

    raw.exec(/*sql*/ `
      CREATE TEMP TABLE memory_entity_relation_merge AS
      WITH ranked AS (
        SELECT
          source_entity_id,
          target_entity_id,
          relation,
          first_seen_at,
          last_seen_at,
          evidence,
          ROW_NUMBER() OVER (
            PARTITION BY source_entity_id, target_entity_id, relation
            ORDER BY last_seen_at DESC, first_seen_at DESC, id DESC
          ) AS rank_latest
        FROM memory_entity_relations
      )
      SELECT
        source_entity_id,
        target_entity_id,
        relation,
        MIN(first_seen_at) AS merged_first_seen_at,
        MAX(last_seen_at) AS merged_last_seen_at,
        MAX(CASE WHEN rank_latest = 1 THEN evidence ELSE NULL END) AS merged_evidence
      FROM ranked
      GROUP BY source_entity_id, target_entity_id, relation
    `);

    raw.exec(/*sql*/ `DELETE FROM memory_entity_relations`);

    raw.exec(/*sql*/ `
      INSERT INTO memory_entity_relations (
        id,
        source_entity_id,
        target_entity_id,
        relation,
        evidence,
        first_seen_at,
        last_seen_at
      )
      SELECT
        lower(hex(randomblob(16))),
        source_entity_id,
        target_entity_id,
        relation,
        merged_evidence,
        merged_first_seen_at,
        merged_last_seen_at
      FROM memory_entity_relation_merge
    `);

    raw.exec(/*sql*/ `DROP TABLE memory_entity_relation_merge`);

    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}

/**
 * Migrate from a column-level UNIQUE on fingerprint to a compound unique
 * index on (fingerprint, scope_id) so that the same item can exist in
 * different scopes independently.
 */
function migrateMemoryItemsFingerprintScopeUnique(database: ReturnType<typeof drizzle<typeof schema>>): void {
  const raw = (database as unknown as { $client: Database }).$client;
  const checkpointKey = 'migration_memory_items_fingerprint_scope_unique_v1';
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = ?`,
  ).get(checkpointKey);
  if (checkpoint) return;

  // Check if the old column-level UNIQUE constraint still exists by inspecting
  // the CREATE TABLE DDL for the word UNIQUE (the PK also creates an autoindex,
  // so we cannot rely on sqlite_autoindex_* presence alone).
  const tableDdl = raw.query(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_items'`,
  ).get() as { sql: string } | null;
  if (!tableDdl || !tableDdl.sql.match(/fingerprint\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)) {
    // No column-level UNIQUE on fingerprint — either fresh DB or already migrated.
    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());
    return;
  }

  // Rebuild the table without the column-level UNIQUE constraint.
  raw.exec('PRAGMA foreign_keys = OFF');
  try {
    raw.exec('BEGIN');

    // Create new table without UNIQUE on fingerprint — all other columns
    // match the latest schema (including migration-added columns).
    raw.exec(/*sql*/ `
      CREATE TABLE memory_items_new (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        statement TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        fingerprint TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_used_at INTEGER,
        importance REAL,
        access_count INTEGER NOT NULL DEFAULT 0,
        valid_from INTEGER,
        invalid_at INTEGER,
        verification_state TEXT NOT NULL DEFAULT 'assistant_inferred',
        scope_id TEXT NOT NULL DEFAULT 'default'
      )
    `);

    raw.exec(/*sql*/ `
      INSERT INTO memory_items_new
      SELECT id, kind, subject, statement, status, confidence, fingerprint,
             first_seen_at, last_seen_at, last_used_at, importance, access_count,
             valid_from, invalid_at, verification_state, scope_id
      FROM memory_items
    `);

    raw.exec(/*sql*/ `DROP TABLE memory_items`);
    raw.exec(/*sql*/ `ALTER TABLE memory_items_new RENAME TO memory_items`);

    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  } finally {
    raw.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * One-shot migration: recompute fingerprints for existing memory items to
 * include the scope_id prefix introduced in the scope-salted fingerprint PR.
 *
 * Old format: sha256(`${kind}|${subject.toLowerCase()}|${statement.toLowerCase()}`)
 * New format: sha256(`${scopeId}|${kind}|${subject.toLowerCase()}|${statement.toLowerCase()}`)
 *
 * Without this migration, pre-upgrade items would never match on re-extraction,
 * causing duplicates and broken deduplication.
 */
function migrateMemoryItemsScopeSaltedFingerprints(database: ReturnType<typeof drizzle<typeof schema>>): void {
  const raw = (database as unknown as { $client: Database }).$client;
  const checkpointKey = 'migration_memory_items_scope_salted_fingerprints_v1';
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = ?`,
  ).get(checkpointKey);
  if (checkpoint) return;

  interface ItemRow {
    id: string;
    kind: string;
    subject: string;
    statement: string;
    scope_id: string;
  }

  const items = raw.query(
    `SELECT id, kind, subject, statement, scope_id FROM memory_items`,
  ).all() as ItemRow[];

  if (items.length === 0) {
    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());
    return;
  }

  try {
    raw.exec('BEGIN');

    const updateStmt = raw.prepare(
      `UPDATE memory_items SET fingerprint = ? WHERE id = ?`,
    );

    for (const item of items) {
      const fingerprint = computeMemoryFingerprint(item.scope_id, item.kind, item.subject, item.statement);
      updateStmt.run(fingerprint, item.id);
    }

    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}

/**
 * One-shot migration: normalize all assistant_id values in assistant-scoped tables
 * to "self" so they are visible after the daemon switched to the implicit single-tenant
 * identity.
 *
 * Before this change, rows were keyed by the real assistantId string passed via the
 * HTTP route. After the route change, all lookups use the constant "self". Without this
 * migration an upgraded daemon would see empty history / attachment lists for existing
 * data that was stored under the old assistantId.
 *
 * Affected tables:
 *   - conversation_keys   UNIQUE (assistant_id, conversation_key)
 *   - attachments         UNIQUE (assistant_id, content_hash) WHERE content_hash IS NOT NULL
 *   - channel_inbound_events  UNIQUE (assistant_id, source_channel, external_chat_id, external_message_id)
 *   - message_runs        no unique constraint on assistant_id
 *
 * Data-safety guarantees:
 *   - conversation_keys: when a key exists under both 'self' and a real assistantId, the
 *     'self' row is updated to point to the real-assistantId conversation (which holds the
 *     historical message thread). The 'self' conversation may be orphaned but is not deleted.
 *   - attachments: message_attachments links are remapped to the surviving attachment before
 *     any duplicate row is deleted, so no message loses its attachment metadata.
 *   - channel_inbound_events: only delivery-tracking metadata, not user content; dedup
 *     keeps one row per unique (channel, chat, message) tuple.
 *   - All conversations and messages remain untouched — only assistant_id index columns
 *     and key-lookup rows are modified.
 */
function migrateAssistantIdToSelf(database: ReturnType<typeof drizzle<typeof schema>>): void {
  const raw = (database as unknown as { $client: Database }).$client;
  const checkpointKey = 'migration_normalize_assistant_id_to_self_v1';
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = ?`,
  ).get(checkpointKey);
  if (checkpoint) return;

  try {
    raw.exec('BEGIN');

    // conversation_keys: UNIQUE (assistant_id, conversation_key)
    //
    // Step 1: Among non-self rows, keep only one per conversation_key so the
    //         bulk UPDATE cannot hit a (non-self-A, key) + (non-self-B, key) collision.
    raw.exec(/*sql*/ `
      DELETE FROM conversation_keys
      WHERE assistant_id != 'self'
        AND rowid NOT IN (
          SELECT MIN(rowid) FROM conversation_keys
          WHERE assistant_id != 'self'
          GROUP BY conversation_key
        )
    `);
    // Step 2: For 'self' rows that have a non-self counterpart with the same
    //         conversation_key, update the 'self' row to use the non-self row's
    //         conversation_id. This preserves the historical conversation (which
    //         has the message history from before the route change) rather than
    //         discarding it in favour of a potentially-empty 'self' conversation.
    raw.exec(/*sql*/ `
      UPDATE conversation_keys
      SET conversation_id = (
        SELECT ck_ns.conversation_id
        FROM conversation_keys ck_ns
        WHERE ck_ns.assistant_id != 'self'
          AND ck_ns.conversation_key = conversation_keys.conversation_key
        ORDER BY ck_ns.rowid
        LIMIT 1
      )
      WHERE assistant_id = 'self'
        AND EXISTS (
          SELECT 1 FROM conversation_keys ck_ns
          WHERE ck_ns.assistant_id != 'self'
            AND ck_ns.conversation_key = conversation_keys.conversation_key
        )
    `);
    // Step 3: Delete the now-redundant non-self rows (their conversation_ids
    //         have been preserved in the 'self' rows above).
    raw.exec(/*sql*/ `
      DELETE FROM conversation_keys
      WHERE assistant_id != 'self'
        AND EXISTS (
          SELECT 1 FROM conversation_keys ck2
          WHERE ck2.assistant_id = 'self'
            AND ck2.conversation_key = conversation_keys.conversation_key
        )
    `);
    // Step 4: Remaining non-self rows have no 'self' counterpart — safe to bulk-update.
    raw.exec(/*sql*/ `
      UPDATE conversation_keys SET assistant_id = 'self' WHERE assistant_id != 'self'
    `);

    // attachments: UNIQUE (assistant_id, content_hash) WHERE content_hash IS NOT NULL
    //
    // message_attachments rows reference attachment IDs with ON DELETE CASCADE, so we
    // must remap links to the surviving row BEFORE deleting duplicates to avoid
    // silently dropping attachment metadata from messages.
    //
    // Step 1: Remap message_attachments from non-self duplicates to their survivor
    //         (MIN rowid per content_hash group), then delete the duplicates.
    raw.exec(/*sql*/ `
      UPDATE message_attachments
      SET attachment_id = (
        SELECT a_survivor.id
        FROM attachments a_survivor
        WHERE a_survivor.assistant_id != 'self'
          AND a_survivor.content_hash = (
            SELECT a_dup.content_hash FROM attachments a_dup
            WHERE a_dup.id = message_attachments.attachment_id
          )
        ORDER BY a_survivor.rowid
        LIMIT 1
      )
      WHERE attachment_id IN (
        SELECT id FROM attachments
        WHERE assistant_id != 'self'
          AND content_hash IS NOT NULL
          AND rowid NOT IN (
            SELECT MIN(rowid) FROM attachments
            WHERE assistant_id != 'self' AND content_hash IS NOT NULL
            GROUP BY content_hash
          )
      )
    `);
    raw.exec(/*sql*/ `
      DELETE FROM attachments
      WHERE assistant_id != 'self'
        AND content_hash IS NOT NULL
        AND rowid NOT IN (
          SELECT MIN(rowid) FROM attachments
          WHERE assistant_id != 'self'
            AND content_hash IS NOT NULL
          GROUP BY content_hash
        )
    `);
    // Step 2: Remap message_attachments from non-self rows conflicting with a 'self'
    //         row to the 'self' row, then delete the now-unlinked non-self rows.
    raw.exec(/*sql*/ `
      UPDATE message_attachments
      SET attachment_id = (
        SELECT a_self.id
        FROM attachments a_self
        WHERE a_self.assistant_id = 'self'
          AND a_self.content_hash = (
            SELECT a_ns.content_hash FROM attachments a_ns
            WHERE a_ns.id = message_attachments.attachment_id
          )
        LIMIT 1
      )
      WHERE attachment_id IN (
        SELECT id FROM attachments
        WHERE assistant_id != 'self'
          AND content_hash IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM attachments a2
            WHERE a2.assistant_id = 'self'
              AND a2.content_hash = attachments.content_hash
          )
      )
    `);
    raw.exec(/*sql*/ `
      DELETE FROM attachments
      WHERE assistant_id != 'self'
        AND content_hash IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM attachments a2
          WHERE a2.assistant_id = 'self'
            AND a2.content_hash = attachments.content_hash
        )
    `);
    // Step 3: Bulk-update remaining non-self rows.
    raw.exec(/*sql*/ `
      UPDATE attachments SET assistant_id = 'self' WHERE assistant_id != 'self'
    `);

    // channel_inbound_events: UNIQUE (assistant_id, source_channel, external_chat_id, external_message_id)
    // Step 1: Dedup non-self rows sharing the same (source_channel, external_chat_id, external_message_id).
    raw.exec(/*sql*/ `
      DELETE FROM channel_inbound_events
      WHERE assistant_id != 'self'
        AND rowid NOT IN (
          SELECT MIN(rowid) FROM channel_inbound_events
          WHERE assistant_id != 'self'
          GROUP BY source_channel, external_chat_id, external_message_id
        )
    `);
    // Step 2: Delete non-self rows conflicting with existing 'self' rows.
    raw.exec(/*sql*/ `
      DELETE FROM channel_inbound_events
      WHERE assistant_id != 'self'
        AND EXISTS (
          SELECT 1 FROM channel_inbound_events e2
          WHERE e2.assistant_id = 'self'
            AND e2.source_channel = channel_inbound_events.source_channel
            AND e2.external_chat_id = channel_inbound_events.external_chat_id
            AND e2.external_message_id = channel_inbound_events.external_message_id
        )
    `);
    // Step 3: Bulk-update remaining non-self rows.
    raw.exec(/*sql*/ `
      UPDATE channel_inbound_events SET assistant_id = 'self' WHERE assistant_id != 'self'
    `);

    // message_runs: no unique constraint on assistant_id — simple bulk update
    raw.exec(/*sql*/ `
      UPDATE message_runs SET assistant_id = 'self' WHERE assistant_id != 'self'
    `);

    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}

/**
 * One-shot migration: rebuild the four tables that previously stored assistant_id
 * to remove that column now that all rows are keyed to the implicit single-tenant
 * identity ("self").
 *
 * Must run AFTER migrateAssistantIdToSelf (which normalises all values to "self")
 * so there are no constraint violations when recreating the tables without the
 * assistant_id dimension.
 *
 * Tables rebuilt:
 *   - conversation_keys       UNIQUE (conversation_key)
 *   - attachments             no structural unique; content-dedup index updated
 *   - channel_inbound_events  UNIQUE (source_channel, external_chat_id, external_message_id)
 *   - message_runs            no unique constraint on assistant_id
 */
function migrateRemoveAssistantIdColumns(database: ReturnType<typeof drizzle<typeof schema>>): void {
  const raw = (database as unknown as { $client: Database }).$client;
  const checkpointKey = 'migration_remove_assistant_id_columns_v1';
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = ?`,
  ).get(checkpointKey);
  if (checkpoint) return;

  raw.exec('PRAGMA foreign_keys = OFF');
  try {
    raw.exec('BEGIN');

    // --- conversation_keys ---
    const ckDdl = raw.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_keys'`,
    ).get() as { sql: string } | null;
    if (ckDdl?.sql.includes('assistant_id')) {
      raw.exec(/*sql*/ `
        CREATE TABLE conversation_keys_new (
          id TEXT PRIMARY KEY,
          conversation_key TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL
        )
      `);
      raw.exec(/*sql*/ `
        INSERT INTO conversation_keys_new (id, conversation_key, conversation_id, created_at)
        SELECT id, conversation_key, conversation_id, created_at FROM conversation_keys
      `);
      raw.exec(/*sql*/ `DROP TABLE conversation_keys`);
      raw.exec(/*sql*/ `ALTER TABLE conversation_keys_new RENAME TO conversation_keys`);
    }

    // --- attachments ---
    const attDdl = raw.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attachments'`,
    ).get() as { sql: string } | null;
    if (attDdl?.sql.includes('assistant_id')) {
      raw.exec(/*sql*/ `
        CREATE TABLE attachments_new (
          id TEXT PRIMARY KEY,
          original_filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          kind TEXT NOT NULL,
          data_base64 TEXT NOT NULL,
          content_hash TEXT,
          thumbnail_base64 TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      raw.exec(/*sql*/ `
        INSERT INTO attachments_new (id, original_filename, mime_type, size_bytes, kind, data_base64, content_hash, thumbnail_base64, created_at)
        SELECT id, original_filename, mime_type, size_bytes, kind, data_base64, content_hash, thumbnail_base64, created_at FROM attachments
      `);
      raw.exec(/*sql*/ `DROP TABLE attachments`);
      raw.exec(/*sql*/ `ALTER TABLE attachments_new RENAME TO attachments`);
    }

    // --- channel_inbound_events ---
    const cieDdl = raw.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel_inbound_events'`,
    ).get() as { sql: string } | null;
    if (cieDdl?.sql.includes('assistant_id')) {
      raw.exec(/*sql*/ `
        CREATE TABLE channel_inbound_events_new (
          id TEXT PRIMARY KEY,
          source_channel TEXT NOT NULL,
          external_chat_id TEXT NOT NULL,
          external_message_id TEXT NOT NULL,
          source_message_id TEXT,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
          delivery_status TEXT NOT NULL DEFAULT 'pending',
          processing_status TEXT NOT NULL DEFAULT 'pending',
          processing_attempts INTEGER NOT NULL DEFAULT 0,
          last_processing_error TEXT,
          retry_after INTEGER,
          raw_payload TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (source_channel, external_chat_id, external_message_id)
        )
      `);
      raw.exec(/*sql*/ `
        INSERT INTO channel_inbound_events_new (
          id, source_channel, external_chat_id, external_message_id, source_message_id,
          conversation_id, message_id, delivery_status, processing_status,
          processing_attempts, last_processing_error, retry_after, raw_payload,
          created_at, updated_at
        )
        SELECT
          id, source_channel, external_chat_id, external_message_id, source_message_id,
          conversation_id, message_id, delivery_status, processing_status,
          processing_attempts, last_processing_error, retry_after, raw_payload,
          created_at, updated_at
        FROM channel_inbound_events
      `);
      raw.exec(/*sql*/ `DROP TABLE channel_inbound_events`);
      raw.exec(/*sql*/ `ALTER TABLE channel_inbound_events_new RENAME TO channel_inbound_events`);
    }

    // --- message_runs ---
    const mrDdl = raw.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_runs'`,
    ).get() as { sql: string } | null;
    if (mrDdl?.sql.includes('assistant_id')) {
      raw.exec(/*sql*/ `
        CREATE TABLE message_runs_new (
          id TEXT PRIMARY KEY,
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
      raw.exec(/*sql*/ `
        INSERT INTO message_runs_new (
          id, conversation_id, message_id, status, pending_confirmation,
          input_tokens, output_tokens, estimated_cost, error, created_at, updated_at
        )
        SELECT
          id, conversation_id, message_id, status, pending_confirmation,
          input_tokens, output_tokens, estimated_cost, error, created_at, updated_at
        FROM message_runs
      `);
      raw.exec(/*sql*/ `DROP TABLE message_runs`);
      raw.exec(/*sql*/ `ALTER TABLE message_runs_new RENAME TO message_runs`);
    }

    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  } finally {
    raw.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * One-shot migration: remove duplicate (provider, provider_call_sid) rows from
 * call_sessions so that the unique index can be created safely on upgraded databases
 * that pre-date the constraint.
 *
 * For each set of duplicates, the most recently updated row is kept.
 */
function migrateCallSessionsProviderSidDedup(database: ReturnType<typeof drizzle<typeof schema>>): void {
  const raw = (database as unknown as { $client: Database }).$client;

  // Quick check: if the unique index already exists, no dedup is needed.
  const idxExists = raw.query(
    `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_call_sessions_provider_sid_unique'`,
  ).get();
  if (idxExists) return;

  // Check if the table even exists yet (first boot).
  const tableExists = raw.query(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'call_sessions'`,
  ).get();
  if (!tableExists) return;

  // Count duplicates before doing any work.
  const dupCount = raw.query(/*sql*/ `
    SELECT COUNT(*) AS c FROM (
      SELECT provider, provider_call_sid
      FROM call_sessions
      WHERE provider_call_sid IS NOT NULL
      GROUP BY provider, provider_call_sid
      HAVING COUNT(*) > 1
    )
  `).get() as { c: number } | null;

  if (!dupCount || dupCount.c === 0) return;

  log.warn({ duplicateGroups: dupCount.c }, 'Deduplicating call_sessions with duplicate provider_call_sid before creating unique index');

  try {
    raw.exec('BEGIN');

    // Keep the most recently updated row per (provider, provider_call_sid);
    // delete the rest.
    raw.exec(/*sql*/ `
      DELETE FROM call_sessions
      WHERE provider_call_sid IS NOT NULL
        AND rowid NOT IN (
          SELECT MAX(rowid) FROM call_sessions
          WHERE provider_call_sid IS NOT NULL
          GROUP BY provider, provider_call_sid
        )
    `);

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}
