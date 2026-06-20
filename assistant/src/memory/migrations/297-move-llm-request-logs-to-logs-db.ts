import {
  type DrizzleDb,
  getSqliteFrom,
  LOGS_DB_SCHEMA,
} from "../db-connection.js";

/**
 * Column names of `llm_request_logs`, in a fixed order used for the
 * cross-database copy. Listed explicitly (rather than `SELECT *`) so the copy
 * is insensitive to the physical column order of the `main` table, which varies
 * with the historical sequence of `ALTER TABLE ... ADD COLUMN` migrations.
 *
 * The first columns are the original base columns; the rest were added by later
 * column migrations.
 */
const COLUMN_NAMES = [
  "id",
  "conversation_id",
  "message_id",
  "provider",
  "request_payload",
  "response_payload",
  "created_at",
  "agent_loop_exit_reason",
  "call_site",
];
const COLUMNS = COLUMN_NAMES.join(", ");

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

function tableExists(
  raw: ReturnType<typeof getSqliteFrom>,
  schema: string,
): boolean {
  return (
    raw
      .query(
        `SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name='llm_request_logs'`,
      )
      .get() != null
  );
}

/**
 * Copy every row of `llm_request_logs` from `main` into the `logs` database,
 * substituting `NULL` for any target column missing in the source. The newer
 * columns (message_id/provider/agent_loop_exit_reason/call_site) are all
 * nullable, so NULL is correct for a legacy row that predates them.
 */
function copyRowsFromMain(raw: ReturnType<typeof getSqliteFrom>): void {
  const presentColumns = new Set(
    (
      raw
        .query(`SELECT name FROM pragma_table_info('llm_request_logs', 'main')`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );
  const selectList = COLUMN_NAMES.map((c) =>
    presentColumns.has(c) ? c : "NULL",
  ).join(", ");
  raw.exec(/*sql*/ `
    INSERT OR IGNORE INTO ${LOGS_DB_SCHEMA}.llm_request_logs (${COLUMNS})
    SELECT ${selectList} FROM main.llm_request_logs
  `);
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
 * This step is idempotent and runs on every startup (it is not checkpoint-
 * gated). It must, because the earlier `createWatchersAndLogsTables` migration
 * recreates an empty `main.llm_request_logs` on every boot via
 * `CREATE TABLE IF NOT EXISTS`; this step re-relocates and drops that shadow so
 * the unqualified name keeps resolving to `logs`.
 *
 * Ordering within the step matters:
 *   1. Create the table in `logs` (safe whether or not `main` has it).
 *   2. If `main` still has the table, copy its rows over (`INSERT OR IGNORE` on
 *      the id PK, so a re-run is a no-op) and drop it.
 *   3. Create the indexes — only now is `main` guaranteed not to shadow the
 *      table, so the unqualified reference resolves to `logs`.
 */
export function migrateMoveLlmRequestLogsToLogsDb(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  raw.exec(CREATE_TABLE(LOGS_DB_SCHEMA));

  if (tableExists(raw, "main")) {
    copyRowsFromMain(raw);
    raw.exec(`DROP TABLE main.llm_request_logs`);
  }

  createIndexes(raw, LOGS_DB_SCHEMA);
}
