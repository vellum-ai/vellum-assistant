import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Creates the `memory_recall_gate_decisions` table for the recall-decision
 * gate experiment. One row per gate evaluation (shadow or live mode).
 *
 * Idempotent — re-running is a no-op once the table and indexes exist.
 */
export function migrateCreateRecallGateDecisions(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_recall_gate_decisions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      decision TEXT NOT NULL,
      rule_fired TEXT,
      safety_floor_hit INTEGER NOT NULL DEFAULT 0,
      safety_floor_tokens TEXT,
      redacted_user_text TEXT,
      prompt_char_count INTEGER NOT NULL,
      prompt_token_estimate INTEGER NOT NULL,
      has_entities INTEGER NOT NULL DEFAULT 0,
      has_question_mark INTEGER NOT NULL DEFAULT 0,
      decision_latency_us INTEGER NOT NULL,
      mode TEXT NOT NULL,
      retrieval_latency_ms INTEGER,
      v3_selector_result TEXT
    )
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_recall_gate_decisions_conv
      ON memory_recall_gate_decisions (conversation_id, turn DESC)
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_recall_gate_decisions_rule
      ON memory_recall_gate_decisions (rule_fired)
  `);

  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_recall_gate_decisions_ts
      ON memory_recall_gate_decisions (timestamp)
  `);
}
