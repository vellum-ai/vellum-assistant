import type { Database } from "bun:sqlite";

import { getLogsDbPath } from "../../util/logs-db-path.js";
import {
  type DrizzleDb,
  getLogsSqlite,
  getSqliteFrom,
} from "../db-connection.js";
import {
  drainStagedTable,
  type RelocationSpec,
  stageTableForRelocation,
} from "./helpers/relocation.js";

/** How to drain `llm_request_logs` from `main` into the logs DB. */
const RELOCATION: RelocationSpec = {
  table: "llm_request_logs",
  targetDbPath: getLogsDbPath,
  columns: [
    "id",
    "conversation_id",
    "message_id",
    "provider",
    "request_payload",
    "response_payload",
    "created_at",
    "agent_loop_exit_reason",
    "call_site",
  ],
};

const CREATE_TABLE = /*sql*/ `
  CREATE TABLE IF NOT EXISTS llm_request_logs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    message_id TEXT,
    provider TEXT,
    request_payload TEXT NOT NULL,
    response_payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    agent_loop_exit_reason TEXT,
    call_site TEXT
  )
`;

/** Create the three indexes on the logs connection's `llm_request_logs`. */
function createIndexes(raw: Database) {
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_llm_request_logs_message_id ON llm_request_logs(message_id)`,
  );
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_llm_request_logs_created_at ON llm_request_logs(created_at)`,
  );
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_llm_request_logs_conv_created ON llm_request_logs(conversation_id, created_at)`,
  );
}

/**
 * Create the `llm_request_logs` table and its indexes on the logs connection.
 * Idempotent (`IF NOT EXISTS`) — the dedicated connection itself performs no DDL
 * on open, so this migration owns the schema.
 */
function ensureLlmRequestLogsSchema(logsRaw: Database): void {
  logsRaw.exec(CREATE_TABLE);
  createIndexes(logsRaw);
}

/**
 * House `llm_request_logs` in its own append-only database
 * (`assistant-logs.db`) rather than the main DB. Keeping this heavy table — and
 * the request/response payloads it stores — in its own file stops it from
 * bloating the main DB and its WAL, and lets the two files VACUUM and
 * checkpoint independently. The Drizzle store reads/writes the table over the
 * dedicated logs connection (see `getLogsDb()`).
 *
 * The move is incremental: this step does metadata-only work — create the table
 * (and indexes) on the logs connection, rename any populated
 * `main.llm_request_logs` aside to `llm_request_logs__relocating` — then drains
 * the staged rows into the logs file in awaited batches (see
 * `helpers/relocation.ts`), keeping the event loop responsive between batches
 * rather than stalling it with a one-shot `INSERT … SELECT` + `DROP` of a
 * multi-GB table.
 *
 * Idempotent and safe to re-run: `stageTableForRelocation` drops a freshly
 * recreated empty shadow, renames a populated table only once, and leaves an
 * in-flight staging table alone; `drainStagedTable` resumes from the remaining
 * rows.
 *
 * Throws (rather than returning) if the logs database cannot be opened, so the
 * runner records the step as failed instead of applied — leaving it to retry on
 * a later boot. The throw is caught per-step by the runner, so startup is not
 * aborted.
 */
export async function migrateMoveLlmRequestLogsToLogsDb(
  database: DrizzleDb,
): Promise<void> {
  const logsRaw = getLogsSqlite();
  if (!logsRaw) {
    throw new Error(
      "logs database unavailable — deferring llm_request_logs relocation",
    );
  }

  ensureLlmRequestLogsSchema(logsRaw);

  const raw = getSqliteFrom(database);
  const needsDrain = stageTableForRelocation(raw, RELOCATION.table);

  if (needsDrain) await drainStagedTable(raw, RELOCATION);
}
