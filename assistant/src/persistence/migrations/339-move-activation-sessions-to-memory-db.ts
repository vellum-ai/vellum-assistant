import type { Database } from "bun:sqlite";

import { getMemoryDbPath } from "../../util/memory-db-path.js";
import {
  type DrizzleDb,
  getMemorySqlite,
  getSqliteFrom,
} from "../db-connection.js";
import {
  drainStagedTable,
  type RelocationSpec,
  stageTableForRelocation,
} from "./helpers/relocation.js";

/**
 * How to drain `activation_sessions` from `main` into the memory DB. Every
 * row is copied: the table is one row per activation-rail conversation, read
 * by the activation funnel for the conversation's whole lifetime.
 */
export const ACTIVATION_SESSIONS_RELOCATION: RelocationSpec = {
  table: "activation_sessions",
  targetDbPath: getMemoryDbPath,
  columns: ["conversation_id", "created_at"],
};

/**
 * Create the `activation_sessions` table on the memory connection. Idempotent
 * (`IF NOT EXISTS`) — the dedicated connection itself performs no DDL on open,
 * so this migration owns the schema. Exported so tests can stand up the
 * memory-side schema without running the full drain.
 */
export function ensureActivationSessionsSchema(memoryRaw: Database): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS activation_sessions (
      conversation_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);
}

/**
 * Move `activation_sessions` — the per-conversation activation-rail marker
 * behind the activation funnel telemetry — into the dedicated memory database
 * (`assistant-memory.db`), joining the memory plugin's other relocated state
 * so its store reads/writes ride the memory connection.
 *
 * Like migration 326 the move is incremental: create the table on the memory
 * connection, rename any populated `main.activation_sessions` aside to
 * `activation_sessions__relocating`, then drain it in awaited batches per
 * {@link ACTIVATION_SESSIONS_RELOCATION}. On a fresh install the main-side
 * table created by migration 274 is empty, so staging just drops it.
 *
 * Throws (rather than returning) if the memory database cannot be opened, so
 * the runner records the step as failed instead of applied and retries it on
 * a later boot — never renaming the source aside without a target to write
 * to. The throw is caught per-step by the runner, so startup is not aborted.
 */
export async function migrateMoveActivationSessionsToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  const memoryRaw = getMemorySqlite();
  if (!memoryRaw) {
    throw new Error(
      "memory database unavailable — deferring activation_sessions relocation",
    );
  }

  ensureActivationSessionsSchema(memoryRaw);

  const raw = getSqliteFrom(database);
  const needsDrain = stageTableForRelocation(
    raw,
    ACTIVATION_SESSIONS_RELOCATION.table,
  );

  if (needsDrain) {
    await drainStagedTable(raw, ACTIVATION_SESSIONS_RELOCATION);
  }
}
