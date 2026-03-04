import type { DrizzleDb } from "../db-connection.js";

/**
 * Tasks, task runs, task candidates, and work items tables with indexes.
 */
export function createTasksAndWorkItemsTables(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      template TEXT NOT NULL,
      input_schema TEXT,
      context_flags TEXT,
      required_tools TEXT,
      created_from_conversation_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      conversation_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at INTEGER,
      finished_at INTEGER,
      error TEXT,
      principal_id TEXT,
      memory_scope_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS task_candidates (
      id TEXT PRIMARY KEY,
      source_conversation_id TEXT NOT NULL,
      compiled_template TEXT NOT NULL,
      confidence REAL,
      required_tools TEXT,
      created_at INTEGER NOT NULL,
      promoted_task_id TEXT
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      title TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      priority_tier INTEGER NOT NULL DEFAULT 1,
      sort_index INTEGER,
      last_run_id TEXT,
      last_run_conversation_id TEXT,
      last_run_status TEXT,
      source_type TEXT,
      source_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Work item run contract snapshot
  try {
    database.run(
      /*sql*/ `ALTER TABLE work_items ADD COLUMN required_tools TEXT`,
    );
  } catch {
    /* already exists */
  }

  // Work item permission preflight columns
  try {
    database.run(
      /*sql*/ `ALTER TABLE work_items ADD COLUMN approved_tools TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE work_items ADD COLUMN approval_status TEXT DEFAULT 'none'`,
    );
  } catch {
    /* already exists */
  }

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_work_items_task_id ON work_items(task_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_work_items_priority_sort ON work_items(priority_tier, sort_index)`,
  );

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_task_candidates_promoted ON task_candidates(promoted_task_id)`,
  );
}
