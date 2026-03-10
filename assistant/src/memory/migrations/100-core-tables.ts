import type { DrizzleDb } from "../db-connection.js";

/**
 * Core tables: conversations, messages, tool_invocations, memory_segments,
 * memory_items, memory_item_sources, memory_item_conflicts, memory_summaries,
 * memory_embeddings, memory_jobs, memory_checkpoints, attachments,
 * message_attachments, message_surfaces, channel_inbound_events,
 * message_runs, cron_jobs, cron_runs, documents,
 * published_pages, shared_app_links, home_base_app_links.
 */
export function createCoreTables(database: DrizzleDb): void {
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
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
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
      vector_json TEXT,
      vector_blob BLOB,
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
}
