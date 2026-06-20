import {
  type DrizzleDb,
  getSqliteFrom,
  LOGS_DB_SCHEMA,
} from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_move_llm_request_logs_to_logs_db_v1";

/**
 * Columns of `llm_request_logs`, in a fixed order used for the cross-database
 * copy. Listed explicitly (rather than `SELECT *`) so the copy is insensitive
 * to the physical column order of the legacy `main` table, which varies with
 * the historical sequence of `ALTER TABLE ... ADD COLUMN` migrations.
 *
 * The first five are the original base columns (always present since the table
 * was first created); the rest were added by later column migrations.
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
 * Copy every row of `llm_request_logs` from `fromSchema` into `toSchema`.
 *
 * The SELECT side substitutes `NULL` for any target column missing in the
 * source. A workspace upgrading from a build that predates the
 * message_id/provider/agent_loop_exit_reason/call_site column migrations still
 * has the original base columns only; this migration runs before those
 * historical column-adders, so a plain `SELECT ${COLUMNS}` would throw on the
 * absent columns. The four newer columns are all nullable, so NULL is the
 * correct value for legacy rows.
 */
function copyRows(
  raw: ReturnType<typeof getSqliteFrom>,
  fromSchema: string,
  toSchema: string,
): void {
  const presentColumns = new Set(
    (
      raw
        .query(`SELECT name FROM pragma_table_info('llm_request_logs', ?)`)
        .all(fromSchema) as Array<{ name: string }>
    ).map((r) => r.name),
  );
  const selectList = COLUMN_NAMES.map((c) =>
    presentColumns.has(c) ? c : "NULL",
  ).join(", ");
  raw.exec(/*sql*/ `
    INSERT OR IGNORE INTO ${toSchema}.llm_request_logs (${COLUMNS})
    SELECT ${selectList} FROM ${fromSchema}.llm_request_logs
  `);
}

/**
 * Move `llm_request_logs` out of the main database and into the attached
 * append-only `logs` database (`assistant-logs.db`).
 *
 * This is the first heavy, append-only table relocated under the DB-split
 * effort: keeping it in its own file stops its growth (and the request/response
 * payloads it stores) from bloating the main DB and its WAL, and lets the two
 * files VACUUM and checkpoint independently.
 *
 * Once the table lives only in `logs`, the unqualified name used by the Drizzle
 * store (`llm_request_logs`) resolves to the attached copy — so query code is
 * unchanged. The legacy DDL for this table has been removed from the historical
 * migrations (101/104/179/212) so they no longer recreate an empty shadow copy
 * in `main`.
 *
 * Ordering within the migration matters:
 *   1. Create the table in `logs` (safe whether or not `main` still has it).
 *   2. If the legacy `main` table is present, copy its rows over and drop it.
 *      `INSERT OR IGNORE` (id is the PK) keeps the copy re-runnable if a prior
 *      attempt crashed after copying but before the drop committed.
 *   3. Create the indexes — only now is `main` guaranteed not to shadow the
 *      table, so the unqualified table reference resolves to `logs`. Building
 *      indexes after the bulk copy is also faster than maintaining them during
 *      the insert.
 */
export function migrateMoveLlmRequestLogsToLogsDb(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(CREATE_TABLE(LOGS_DB_SCHEMA));

    if (tableExists(raw, "main")) {
      copyRows(raw, "main", LOGS_DB_SCHEMA);
      raw.exec(`DROP TABLE main.llm_request_logs`);
    }

    createIndexes(raw, LOGS_DB_SCHEMA);
  });
}

/**
 * Reverse the move: recreate the table in `main`, copy rows back from `logs`,
 * and drop the `logs` copy. Best-effort — intended for rollback during
 * development, not routine operation.
 */
export function downMoveLlmRequestLogsToLogsDb(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  raw.exec(CREATE_TABLE("main"));

  if (tableExists(raw, LOGS_DB_SCHEMA)) {
    copyRows(raw, LOGS_DB_SCHEMA, "main");
    raw.exec(`DROP TABLE ${LOGS_DB_SCHEMA}.llm_request_logs`);
  }

  createIndexes(raw, "main");
}
