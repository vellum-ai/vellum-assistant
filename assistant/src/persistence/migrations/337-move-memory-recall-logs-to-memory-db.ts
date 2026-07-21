import type { Database } from "bun:sqlite";

import { getMemoryDbPath } from "../../util/memory-db-path.js";
import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocationSpec,
  runMemoryTableRelocation,
} from "./helpers/relocation.js";

/**
 * How to drain `memory_recall_logs` from `main` into the memory DB. Full copy
 * — the inspector reads arbitrary historical turns, so every row is worth
 * preserving. `query_context` was added by migration 211, so a legacy source
 * may lack the column; the drain NULL-fills it.
 */
export const RECALL_LOGS_RELOCATION: RelocationSpec = {
  table: "memory_recall_logs",
  targetDbPath: getMemoryDbPath,
  columns: [
    "id",
    "conversation_id",
    "message_id",
    "enabled",
    "degraded",
    "provider",
    "model",
    "degradation_json",
    "semantic_hits",
    "merged_count",
    "selected_count",
    "tier1_count",
    "tier2_count",
    "hybrid_search_latency_ms",
    "sparse_vector_used",
    "injected_tokens",
    "latency_ms",
    "top_candidates_json",
    "injected_text",
    "reason",
    "query_context",
    "created_at",
  ],
};

const CREATE_TABLE = /*sql*/ `
  CREATE TABLE IF NOT EXISTS memory_recall_logs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    message_id TEXT,
    enabled INTEGER NOT NULL,
    degraded INTEGER NOT NULL,
    provider TEXT,
    model TEXT,
    degradation_json TEXT,
    semantic_hits INTEGER NOT NULL,
    merged_count INTEGER NOT NULL,
    selected_count INTEGER NOT NULL,
    tier1_count INTEGER NOT NULL,
    tier2_count INTEGER NOT NULL,
    hybrid_search_latency_ms INTEGER NOT NULL,
    sparse_vector_used INTEGER NOT NULL,
    injected_tokens INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    top_candidates_json TEXT NOT NULL,
    injected_text TEXT,
    reason TEXT,
    query_context TEXT,
    created_at INTEGER NOT NULL
  )
`;

/**
 * Create the `memory_recall_logs` table and its indexes (mirroring migration
 * 194, with the `query_context` column from migration 211 built in) on the
 * memory connection. Idempotent (`IF NOT EXISTS`) — the dedicated connection
 * itself performs no DDL on open, so this migration owns the schema. Exported
 * so tests can stand up the memory-side schema without running the full
 * drain.
 */
export function ensureRecallLogsSchema(memoryRaw: Database): void {
  memoryRaw.exec(CREATE_TABLE);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_recall_logs_message_id
      ON memory_recall_logs (message_id)
  `);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_recall_logs_conversation_id
      ON memory_recall_logs (conversation_id)
  `);
}

/**
 * Move `memory_recall_logs` — the per-turn memory recall telemetry consumed
 * by the inspector — into the dedicated memory database
 * (`assistant-memory.db`), alongside the other relocated per-turn memory log
 * tables. One row is appended per recall pass, so housing the table with the
 * other high-churn memory state keeps the main DB and its WAL out of that
 * write path; the accessors in
 * `plugins/defaults/memory/memory-recall-log-store.ts` read/write it over the
 * dedicated memory connection.
 *
 * Registered with `dependsOn` on migrations 194 (creator) and 211
 * (`query_context` column), so the move never outruns either on a database
 * where they are still pending.
 */
export async function migrateMoveMemoryRecallLogsToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  await runMemoryTableRelocation(
    database,
    RECALL_LOGS_RELOCATION,
    ensureRecallLogsSchema,
  );
}
