import type { Database } from "bun:sqlite";

import { getMemoryDbPath } from "../../util/memory-db-path.js";
import type { DrizzleDb } from "../db-connection.js";
import {
  type RelocationSpec,
  runMemoryTableRelocation,
} from "./helpers/relocation.js";

/**
 * How to drain `memory_v2_activation_logs` from `main` into the memory DB.
 * Full copy — the concept-frequency aggregator scans the entire history, so
 * every row is worth preserving.
 */
export const ACTIVATION_LOGS_RELOCATION: RelocationSpec = {
  table: "memory_v2_activation_logs",
  targetDbPath: getMemoryDbPath,
  columns: [
    "id",
    "conversation_id",
    "message_id",
    "turn",
    "mode",
    "concepts_json",
    "skills_json",
    "config_json",
    "created_at",
  ],
};

const CREATE_TABLE = /*sql*/ `
  CREATE TABLE IF NOT EXISTS memory_v2_activation_logs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    message_id TEXT,
    turn INTEGER NOT NULL,
    mode TEXT NOT NULL,
    concepts_json TEXT NOT NULL,
    skills_json TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`;

/**
 * Create the `memory_v2_activation_logs` table and its indexes (mirroring
 * migration 234) on the memory connection. Idempotent (`IF NOT EXISTS`) — the
 * dedicated connection itself performs no DDL on open, so this migration owns
 * the schema. Exported so tests can stand up the memory-side schema without
 * running the full drain.
 */
export function ensureActivationLogsSchema(memoryRaw: Database): void {
  memoryRaw.exec(CREATE_TABLE);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v2_activation_logs_message_id
      ON memory_v2_activation_logs (message_id)
  `);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v2_activation_logs_conversation_id
      ON memory_v2_activation_logs (conversation_id)
  `);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v2_activation_logs_created_at
      ON memory_v2_activation_logs (created_at)
  `);
}

/**
 * Move `memory_v2_activation_logs` — the per-turn v2 activation telemetry log
 * — into the dedicated memory database (`assistant-memory.db`), alongside
 * `memory_jobs` (migration 298) and `memory_v2_injection_events` (migration
 * 326). One row is appended per activation pass, so housing the table with
 * the other high-churn memory state keeps the main DB and its WAL out of
 * that write path; the accessors in
 * `plugins/defaults/memory/memory-v2-activation-log-store.ts` read/write it
 * over the dedicated memory connection.
 *
 * Registered with `dependsOn` on migrations 234 (creator) and 256 (whose
 * backfill reads this table from `main`), so the move never outruns either
 * on a database where they are still pending.
 */
export async function migrateMoveMemoryV2ActivationLogsToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  await runMemoryTableRelocation(
    database,
    ACTIVATION_LOGS_RELOCATION,
    ensureActivationLogsSchema,
  );
}
