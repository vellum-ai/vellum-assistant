import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * One-shot migration: rebuild llm_usage_events to drop the assistant_id column.
 *
 * This is a SEPARATE migration from migrateRemoveAssistantIdColumns so that installs
 * where the 4-table version of that migration already ran (checkpoint already set)
 * still get the llm_usage_events column removed. Without a separate checkpoint key,
 * those installs would skip the llm_usage_events rebuild entirely.
 *
 * Safe on fresh installs (DDL guard exits early) and idempotent via checkpoint.
 */
export function migrateLlmUsageEventsDropAssistantId(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = "migration_remove_assistant_id_lue_v1";
  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  // DDL guard: if the column was already removed (fresh install or migrateRemoveAssistantIdColumns
  // ran with the llm_usage_events block), just record the checkpoint and exit.
  const lueDdl = raw
    .query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'llm_usage_events'`,
    )
    .get() as { sql: string } | null;

  if (!lueDdl?.sql.includes("assistant_id")) {
    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());
    return;
  }

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec("BEGIN");

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
 * Add the assistant_id column back to llm_usage_events.
 *
 * NOTE: The data previously stored in assistant_id is lost — all rows will
 * have assistant_id = NULL after this down migration. This only restores
 * the column structure so that older code expecting the column can function.
 */
export function downLlmUsageEventsDropAssistantId(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const ddl = raw
    .query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'llm_usage_events'`,
    )
    .get() as { sql: string } | null;
  if (!ddl || ddl.sql.includes("assistant_id")) return;

  try {
    raw.exec(
      /*sql*/ `ALTER TABLE llm_usage_events ADD COLUMN assistant_id TEXT`,
    );
  } catch {
    /* column already exists */
  }
}
