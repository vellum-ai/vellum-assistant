import { getDb, getSqliteFrom } from './db-connection.js';
import { getLogger } from '../util/logger.js';
import {
  migrateJobDeferrals,
  migrateToolInvocationsFk,
  migrateMemoryEntityRelationDedup,
  migrateMemoryItemsFingerprintScopeUnique,
  migrateMemoryItemsScopeSaltedFingerprints,
  migrateAssistantIdToSelf,
  migrateRemoveAssistantIdColumns,
  migrateLlmUsageEventsDropAssistantId,
  migrateExtConvBindingsChannelChatUnique,
  migrateCallSessionsProviderSidDedup,
  migrateCallSessionsAddInitiatedFrom,
  migrateMemoryFtsBackfill,
  migrateGuardianActionTables,
} from './schema-migration.js';

const log = getLogger('memory-db');

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
      context_compacted_at INTEGER,
      source TEXT NOT NULL DEFAULT 'user'
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
      pending_secret TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  try { database.run(/*sql*/ `ALTER TABLE message_runs ADD COLUMN pending_secret TEXT`); } catch (e) { log.debug({ err: e }, 'ALTER TABLE message_runs ADD COLUMN pending_secret (likely already exists)'); }

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
      schedule_syntax TEXT NOT NULL DEFAULT 'cron',
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
  try { database.run(/*sql*/ `ALTER TABLE conversations ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE conversations ADD COLUMN memory_scope_id TEXT NOT NULL DEFAULT 'default'`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE attachments ADD COLUMN thumbnail_base64 TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE cron_jobs ADD COLUMN schedule_syntax TEXT NOT NULL DEFAULT 'cron'`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE messages ADD COLUMN metadata TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE memory_embeddings ADD COLUMN content_hash TEXT`); } catch { /* already exists */ }

  migrateJobDeferrals(database);
  migrateToolInvocationsFk(database);
  migrateMemoryEntityRelationDedup(database);
  migrateMemoryItemsFingerprintScopeUnique(database);
  migrateMemoryItemsScopeSaltedFingerprints(database);
  migrateAssistantIdToSelf(database);
  migrateRemoveAssistantIdColumns(database);
  migrateLlmUsageEventsDropAssistantId(database);

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
  // Partial covering index for directItemSearch: the LIKE '%term%' pattern can't
  // seek a B-tree, but this index lets SQLite scan only active non-invalidated rows
  // and evaluate LIKE + return columns without touching the main table.
  database.run(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_items_active_search
    ON memory_items(last_seen_at DESC, subject, statement, id, kind, confidence, importance, first_seen_at, scope_id)
    WHERE status = 'active' AND invalid_at IS NULL
  `);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_target ON memory_embeddings(target_type, target_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_provider_model ON memory_embeddings(provider, model)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_content_hash ON memory_embeddings(content_hash, provider, model)`);
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
  // Deduplicate before creating unique index — existing DBs may have duplicate content_hash values.
  // Re-point message_attachments to the survivor (MIN rowid per content_hash), then delete dupes.
  {
    const raw = getSqliteFrom(database);
    raw.exec(/*sql*/ `
      UPDATE message_attachments
      SET attachment_id = (
        SELECT a_survivor.id
        FROM attachments a_survivor
        WHERE a_survivor.content_hash = (
          SELECT a_dup.content_hash FROM attachments a_dup
          WHERE a_dup.id = message_attachments.attachment_id
        )
        ORDER BY a_survivor.rowid
        LIMIT 1
      )
      WHERE attachment_id IN (
        SELECT id FROM attachments
        WHERE content_hash IS NOT NULL
          AND rowid NOT IN (
            SELECT MIN(rowid) FROM attachments
            WHERE content_hash IS NOT NULL
            GROUP BY content_hash
          )
      )
    `);
    raw.exec(/*sql*/ `
      DELETE FROM attachments
      WHERE content_hash IS NOT NULL
        AND rowid NOT IN (
          SELECT MIN(rowid) FROM attachments
          WHERE content_hash IS NOT NULL
          GROUP BY content_hash
        )
    `);
  }
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
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_cron_jobs_syntax_enabled_next_run ON cron_jobs(schedule_syntax, enabled, next_run_at)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_cron_runs_job_id ON cron_runs(job_id)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_accounts_service ON accounts(service)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status)`);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_created_at ON llm_usage_events(created_at)`);
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

  // Work item run contract snapshot
  try { database.run(/*sql*/ `ALTER TABLE work_items ADD COLUMN required_tools TEXT`); } catch (e) { log.debug({ err: e }, 'ALTER TABLE work_items ADD COLUMN required_tools (likely already exists)'); }

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

  // ── External Conversation Bindings ──────────────────────────────────

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS external_conversation_bindings (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      source_channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      external_user_id TEXT,
      display_name TEXT,
      username TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_inbound_at INTEGER,
      last_outbound_at INTEGER
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_ext_conv_bindings_channel_chat ON external_conversation_bindings(source_channel, external_chat_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_ext_conv_bindings_channel ON external_conversation_bindings(source_channel)`);

  migrateExtConvBindingsChannelChatUnique(database);

  // ── Channel Guardian ───────────────────────────────────────────────

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

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_guardian_challenges_lookup ON channel_guardian_verification_challenges(assistant_id, channel, challenge_hash, status)`);

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

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_guardian_approval_run ON channel_guardian_approval_requests(run_id, status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_guardian_approval_status ON channel_guardian_approval_requests(status)`);

  // Migration: add assistant_id column to scope approval requests by assistant.
  // Existing rows default to 'self' for backward compatibility.
  try { database.run(/*sql*/ `ALTER TABLE channel_guardian_approval_requests ADD COLUMN assistant_id TEXT NOT NULL DEFAULT 'self'`); } catch { /* already exists */ }

  // ── Channel Guardian Verification Rate Limits ─────────────────────

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
  try { database.run(/*sql*/ `ALTER TABLE channel_guardian_rate_limits ADD COLUMN attempt_timestamps_json TEXT NOT NULL DEFAULT '[]'`); } catch { /* already exists */ }

  // Migration: re-add legacy columns for databases created during the brief window when
  // PR #6748 was live (columns were absent from CREATE TABLE). These columns are not read
  // by app logic but must exist so drizzle inserts don't fail.
  try { database.run(/*sql*/ `ALTER TABLE channel_guardian_rate_limits ADD COLUMN invalid_attempts INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE channel_guardian_rate_limits ADD COLUMN window_started_at INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }

  database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_guardian_rate_limits_actor ON channel_guardian_rate_limits(assistant_id, channel, actor_external_user_id, actor_chat_id)`);

  // ── Media Assets ───────────────────────────────────────────────────

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      duration_seconds REAL,
      file_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'registered',
      media_type TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Drop the old non-unique index so it can be recreated as UNIQUE (migration for existing databases)
  database.run(/*sql*/ `DROP INDEX IF EXISTS idx_media_assets_file_hash`);
  database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_media_assets_file_hash ON media_assets(file_hash)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_assets_status ON media_assets(status)`);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS processing_stages (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      progress INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      started_at INTEGER,
      completed_at INTEGER
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_processing_stages_asset_id ON processing_stages(asset_id)`);

  // ── Media Keyframes ─────────────────────────────────────────────────

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS media_keyframes (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      timestamp REAL NOT NULL,
      file_path TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_keyframes_asset_id ON media_keyframes(asset_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_keyframes_asset_timestamp ON media_keyframes(asset_id, timestamp)`);

  // ── Media Vision Outputs ────────────────────────────────────────────

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS media_vision_outputs (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      keyframe_id TEXT NOT NULL REFERENCES media_keyframes(id) ON DELETE CASCADE,
      analysis_type TEXT NOT NULL,
      output TEXT NOT NULL,
      confidence REAL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_vision_outputs_asset_id ON media_vision_outputs(asset_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_vision_outputs_keyframe_id ON media_vision_outputs(keyframe_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_vision_outputs_asset_type ON media_vision_outputs(asset_id, analysis_type)`);

  // ── Media Timelines ─────────────────────────────────────────────────

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS media_timelines (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      segment_type TEXT NOT NULL,
      attributes TEXT,
      confidence REAL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_timelines_asset_id ON media_timelines(asset_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_timelines_asset_time ON media_timelines(asset_id, start_time)`);

  // ── Media Events ──────────────────────────────────────────────────

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS media_events (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      confidence REAL NOT NULL,
      reasons TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_events_asset_id ON media_events(asset_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_events_asset_type ON media_events(asset_id, event_type)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_events_confidence ON media_events(confidence DESC)`);

  // ── Media Tracking Profiles ─────────────────────────────────────────

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS media_tracking_profiles (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      capabilities TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_tracking_profiles_asset_id ON media_tracking_profiles(asset_id)`);

  // ── Media Event Feedback ──────────────────────────────────────────

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS media_event_feedback (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES media_events(id) ON DELETE CASCADE,
      feedback_type TEXT NOT NULL,
      original_start_time REAL,
      original_end_time REAL,
      corrected_start_time REAL,
      corrected_end_time REAL,
      notes TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_event_feedback_asset_id ON media_event_feedback(asset_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_event_feedback_event_id ON media_event_feedback(event_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_event_feedback_type ON media_event_feedback(asset_id, feedback_type)`);

  migrateGuardianActionTables(database);

  migrateMemoryFtsBackfill(database);
}
