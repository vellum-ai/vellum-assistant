import {
  type DrizzleDb,
  getSqliteFrom,
  LOGS_DB_SCHEMA,
} from "../db-connection.js";
import {
  drainStagedTable,
  isSchemaAttached,
  stageTableForRelocation,
} from "../relocation.js";

const CREATE_TABLE = (schema: string): string => /*sql*/ `
  CREATE TABLE IF NOT EXISTS ${schema}.llm_request_logs (
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

/**
 * Create the three indexes in `schema`. The index names are schema-qualified;
 * the table name in `CREATE INDEX` must be unqualified and is resolved within
 * the index's schema — so the table must already resolve to `schema` (i.e. no
 * same-named table shadowing it in `main`) when this runs.
 */
function createIndexes(raw: ReturnType<typeof getSqliteFrom>, schema: string) {
  raw.exec(
    `CREATE INDEX IF NOT EXISTS ${schema}.idx_llm_request_logs_message_id ON llm_request_logs(message_id)`,
  );
  raw.exec(
    `CREATE INDEX IF NOT EXISTS ${schema}.idx_llm_request_logs_created_at ON llm_request_logs(created_at)`,
  );
  raw.exec(
    `CREATE INDEX IF NOT EXISTS ${schema}.idx_llm_request_logs_conv_created ON llm_request_logs(conversation_id, created_at)`,
  );
}

/**
 * Keep `llm_request_logs` housed in the attached append-only `logs` database
 * (`assistant-logs.db`) rather than the main DB. Keeping this heavy table — and
 * the request/response payloads it stores — in its own file stops it from
 * bloating the main DB and its WAL, and lets the two files VACUUM and
 * checkpoint independently. Once it lives only in `logs`, the unqualified name
 * used by the Drizzle store resolves to the attached copy, so query code is
 * unchanged.
 *
 * The move is incremental: this step does metadata-only work — create the table
 * in `logs`, rename any populated `main.llm_request_logs` aside to
 * `llm_request_logs__relocating` — then drains the staged rows into `logs` in
 * awaited batches (see `relocation.ts`), keeping the event loop responsive
 * between batches rather than stalling it with a one-shot `INSERT … SELECT` +
 * `DROP` of a multi-GB table.
 *
 * Idempotent and safe to re-run: `stageTableForRelocation` drops a freshly
 * recreated empty shadow, renames a populated table only once, and leaves an
 * in-flight staging table alone; `drainStagedTable` resumes from the remaining
 * rows. Bails out (retrying next boot) if the `logs` database failed to attach.
 */
export async function migrateMoveLlmRequestLogsToLogsDb(
  database: DrizzleDb,
): Promise<void> {
  const raw = getSqliteFrom(database);

  if (!isSchemaAttached(raw, LOGS_DB_SCHEMA)) return;

  raw.exec(CREATE_TABLE(LOGS_DB_SCHEMA));

  const needsDrain = stageTableForRelocation(raw, "llm_request_logs");

  // Only now is `main` guaranteed not to shadow the table, so the unqualified
  // reference in CREATE INDEX resolves to `logs`.
  createIndexes(raw, LOGS_DB_SCHEMA);

  if (needsDrain) await drainStagedTable("llm_request_logs");
}
