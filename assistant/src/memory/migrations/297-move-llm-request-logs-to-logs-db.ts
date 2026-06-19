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
 */
const COLUMNS = [
  "id",
  "conversation_id",
  "message_id",
  "provider",
  "request_payload",
  "response_payload",
  "created_at",
  "agent_loop_exit_reason",
  "call_site",
].join(", ");

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
      raw.exec(/*sql*/ `
        INSERT OR IGNORE INTO ${LOGS_DB_SCHEMA}.llm_request_logs (${COLUMNS})
        SELECT ${COLUMNS} FROM main.llm_request_logs
      `);
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
    raw.exec(/*sql*/ `
      INSERT OR IGNORE INTO main.llm_request_logs (${COLUMNS})
      SELECT ${COLUMNS} FROM ${LOGS_DB_SCHEMA}.llm_request_logs
    `);
    raw.exec(`DROP TABLE ${LOGS_DB_SCHEMA}.llm_request_logs`);
  }

  createIndexes(raw, "main");
}
