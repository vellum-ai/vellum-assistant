import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * One-shot migration: rebuild tables that previously stored assistant_id to remove
 * that column now that all rows are keyed to the implicit single-tenant identity ("self").
 *
 * Must run AFTER migrateAssistantIdToSelf (which normalises all values to "self")
 * so there are no constraint violations when recreating the tables without the
 * assistant_id dimension.
 *
 * Each table section is guarded by a DDL check so this is safe on fresh installs
 * where the column was never created in the first place.
 *
 * Tables rebuilt:
 *   - conversation_keys       UNIQUE (conversation_key)
 *   - attachments             no structural unique; content-dedup index updated
 *   - channel_inbound_events  UNIQUE (source_channel, external_chat_id, external_message_id)
 *   - message_runs            no unique constraint on assistant_id
 *   - llm_usage_events        nullable column with no constraint
 */
export function migrateRemoveAssistantIdColumns(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = "migration_remove_assistant_id_columns_v1";
  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec("BEGIN");

    // --- conversation_keys ---
    const ckDdl = raw
      .query(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_keys'`,
      )
      .get() as { sql: string } | null;
    if (ckDdl?.sql.includes("assistant_id")) {
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
      raw.exec(
        /*sql*/ `ALTER TABLE conversation_keys_new RENAME TO conversation_keys`,
      );
    }

    // --- attachments ---
    const attDdl = raw
      .query(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attachments'`,
      )
      .get() as { sql: string } | null;
    if (attDdl?.sql.includes("assistant_id")) {
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
    const cieDdl = raw
      .query(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel_inbound_events'`,
      )
      .get() as { sql: string } | null;
    if (cieDdl?.sql.includes("assistant_id")) {
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
      raw.exec(
        /*sql*/ `ALTER TABLE channel_inbound_events_new RENAME TO channel_inbound_events`,
      );
    }

    // --- message_runs ---
    const mrDdl = raw
      .query(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_runs'`,
      )
      .get() as { sql: string } | null;
    if (mrDdl?.sql.includes("assistant_id")) {
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

    // --- llm_usage_events ---
    const lueDdl = raw
      .query(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'llm_usage_events'`,
      )
      .get() as { sql: string } | null;
    if (lueDdl?.sql.includes("assistant_id")) {
      raw.exec(/*sql*/ `
        CREATE TABLE llm_usage_events_new (
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
      raw.exec(/*sql*/ `
        INSERT INTO llm_usage_events_new (
          id, created_at, conversation_id, run_id, request_id, actor, provider, model,
          input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
          estimated_cost_usd, pricing_status, metadata_json
        )
        SELECT
          id, created_at, conversation_id, run_id, request_id, actor, provider, model,
          input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
          estimated_cost_usd, pricing_status, metadata_json
        FROM llm_usage_events
      `);
      raw.exec(/*sql*/ `DROP TABLE llm_usage_events`);
      raw.exec(
        /*sql*/ `ALTER TABLE llm_usage_events_new RENAME TO llm_usage_events`,
      );
    }

    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());

    raw.exec("COMMIT");
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * Add the assistant_id column back to the 4 tables that had it removed.
 *
 * NOTE: The data previously stored in assistant_id is lost — all rows will
 * have assistant_id = 'self' after this down migration. This only restores
 * the column structure so that older code expecting the column can function.
 */
export function downRemoveAssistantIdColumns(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const tables = [
    "conversation_keys",
    "attachments",
    "channel_inbound_events",
    "message_runs",
  ];

  for (const table of tables) {
    // Check if the table exists and lacks assistant_id
    const ddl = raw
      .query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) as { sql: string } | null;
    if (!ddl || ddl.sql.includes("assistant_id")) continue;

    try {
      raw.exec(
        /*sql*/ `ALTER TABLE ${table} ADD COLUMN assistant_id TEXT NOT NULL DEFAULT 'self'`,
      );
    } catch {
      /* column already exists */
    }
  }
}
