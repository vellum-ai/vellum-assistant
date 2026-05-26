import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Creates the `compaction_logs` table — one row per compaction event
 * where `context/compactor.ts` actually invoked `provider.sendMessage`.
 *
 * Pairs with `llm_request_logs.call_site = 'compactionAgent'` rows
 * (migration 264 + PR 2). `llm_request_log_id` is the soft FK that
 * links a compaction event to the underlying LLM call.
 *
 * Captures the dimensions the call_site tag can't: trigger mode,
 * outcome bucket, before/after message + token counts, model, latency,
 * error message on provider failure, and a capped summary excerpt.
 *
 * Idempotent — re-running is a no-op once the table and indexes exist.
 * Modeled on migration 264.
 *
 * Surfaced in the Inspector's Compaction Trail tab (PR 4).
 */
export function migrateCompactionLogs(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  raw.exec(`
    CREATE TABLE IF NOT EXISTS compaction_logs (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL,
      llm_request_log_id TEXT,
      mode TEXT NOT NULL,
      outcome TEXT NOT NULL,
      before_message_count INTEGER NOT NULL,
      after_message_count INTEGER NOT NULL,
      before_estimated_tokens INTEGER NOT NULL,
      after_estimated_tokens INTEGER NOT NULL,
      max_input_tokens INTEGER NOT NULL,
      threshold_tokens INTEGER NOT NULL,
      summary_input_tokens INTEGER NOT NULL,
      summary_output_tokens INTEGER NOT NULL,
      model TEXT,
      latency_ms INTEGER NOT NULL,
      error_message TEXT,
      summary_excerpt TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_compaction_logs_conversation
      ON compaction_logs(conversation_id, created_at)
  `);

  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_compaction_logs_created_at
      ON compaction_logs(created_at)
  `);
}
