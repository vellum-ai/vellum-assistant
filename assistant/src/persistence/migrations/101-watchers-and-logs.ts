import type { DrizzleDb } from "../db-connection.js";

/**
 * Watchers, watcher events, LLM request logs, LLM usage events,
 * memory entities, entity relations, item entities, FTS table + triggers,
 * and conversation keys.
 */
export function createWatchersAndLogsTables(database: DrizzleDb): void {
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
  // Triggers below are atomic with the triggering statement: if the FTS
  // operation fails, the base table write rolls back too. A corrupted FTS
  // table will block all memory_segments writes until rebuilt. See the
  // analogous comment in 116-messages-fts.ts for recovery steps.
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
}
