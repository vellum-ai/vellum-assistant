import type { DrizzleDb } from "../db-connection.js";

/**
 * Create the workflow-engine persistence tables.
 *
 * `workflow_runs` is one row per orchestration run (a sandboxed script that
 * spawns parallel leaf agents). `workflow_journal` is an append-only log of
 * every leaf call (agent / host function / nested workflow) keyed by
 * `(run_id, seq)`, so a run can RESUME after a daemon restart by replaying
 * cached results for the unchanged call prefix.
 *
 * Idempotent — re-running is a no-op once the tables and index exist.
 */
export function migrateWorkflowRuns(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      name TEXT,
      script_source TEXT NOT NULL,
      script_hash TEXT NOT NULL,
      args_json TEXT,
      capabilities_json TEXT,
      status TEXT NOT NULL,
      conversation_id TEXT,
      agents_spawned INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      error TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      finished_at INTEGER
    )
  `);
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created_at ON workflow_runs (status, created_at)`,
  );
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS workflow_journal (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      call_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      request_json TEXT,
      result_json TEXT,
      status TEXT NOT NULL,
      created_at INTEGER,
      PRIMARY KEY (run_id, seq)
    )
  `);
}
