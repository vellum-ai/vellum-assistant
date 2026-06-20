import {
  type DrizzleDb,
  getSqliteFrom,
  MEMORY_DB_SCHEMA,
} from "../db-connection.js";
import {
  drainStagedTable,
  isSchemaAttached,
  stageTableForRelocation,
} from "../relocation.js";

const CREATE_TABLE = (schema: string): string => /*sql*/ `
  CREATE TABLE IF NOT EXISTS ${schema}.memory_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    deferrals INTEGER NOT NULL DEFAULT 0,
    run_after INTEGER NOT NULL,
    last_error TEXT,
    started_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

/**
 * Recreate the two `memory_jobs` indexes in `schema`. As in the table DDL the
 * `CREATE INDEX` table reference is unqualified and resolved within the index's
 * schema, so the source table must no longer shadow it in `main`.
 */
function createIndexes(raw: ReturnType<typeof getSqliteFrom>, schema: string) {
  raw.exec(
    `CREATE INDEX IF NOT EXISTS ${schema}.idx_memory_jobs_status_run_after ON memory_jobs(status, run_after)`,
  );
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS ${schema}.idx_memory_jobs_conflict_resolve_dedupe
    ON memory_jobs(
      type,
      status,
      json_extract(payload, '$.messageId'),
      COALESCE(json_extract(payload, '$.scopeId'), 'default')
    )
  `);
}

/**
 * Move the `memory_jobs` work queue into the attached `memory` database
 * (`assistant-memory.db`). The queue is the heaviest, highest-churn table —
 * left in the main DB a runaway backlog bloats it (and its WAL) to many GB.
 * Splitting it out lets the queue grow, VACUUM, and checkpoint independently.
 *
 * Like the `llm_request_logs` move (migration 297) this is incremental: create
 * the table in `memory`, rename any populated `main.memory_jobs` aside to
 * `memory_jobs__relocating`, then drain it in awaited batches. The drain (see
 * `relocation.ts`) copies only the rows worth keeping — `pending`/`running`
 * jobs — into `memory` and purges the terminal (`completed`/`failed`) rows in
 * batches without copying them, which is where the bulk of a runaway queue
 * lives.
 *
 * Because the drain is awaited as part of this step, the pending/running jobs
 * are in their new home before the memory jobs worker starts later in daemon
 * startup — the worker never observes a transiently empty queue. Bails out
 * (retrying next boot) if the `memory` database failed to attach — never
 * renaming the source aside without a target to write to.
 */
export async function migrateMoveMemoryJobsToMemoryDb(
  database: DrizzleDb,
): Promise<void> {
  const raw = getSqliteFrom(database);

  if (!isSchemaAttached(raw, MEMORY_DB_SCHEMA)) return;

  raw.exec(CREATE_TABLE(MEMORY_DB_SCHEMA));

  const needsDrain = stageTableForRelocation(raw, "memory_jobs");

  createIndexes(raw, MEMORY_DB_SCHEMA);

  if (needsDrain) await drainStagedTable("memory_jobs");
}
