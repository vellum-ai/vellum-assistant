import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Autonomous Execution Engine MVP — Phase 10A.
 *
 * Adds three tables for durable, crash-recoverable multi-step plans:
 *
 * - `plans` — one row per autonomous goal. Status enum: pending | running |
 *   completed | failed | cancelled.
 * - `plan_steps` — ordered child rows of a plan; `status` mirrors the plan.
 * - `plan_step_runs` — append-only attempt history per step (retries +
 *   recovery rewrites the most recent run for the step).
 *
 * Shape mirrors `schedule_jobs/_runs` so the crash-recovery pattern from
 * `assistant/src/schedule/schedule-recovery.ts` can be re-used verbatim.
 *
 * Uses IF NOT EXISTS for idempotency.
 */
export function migratePlanExecutionTables(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  raw.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id                  TEXT PRIMARY KEY,
      scope_id            TEXT NOT NULL DEFAULT 'default',
      goal                TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      conversation_id     TEXT,
      cancellation_reason TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      completed_at        INTEGER
    )
  `);
  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_plans_scope_status
      ON plans(scope_id, status)
  `);
  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_plans_scope_updated
      ON plans(scope_id, updated_at)
  `);

  raw.exec(`
    CREATE TABLE IF NOT EXISTS plan_steps (
      id           TEXT PRIMARY KEY,
      plan_id      TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      step_order   INTEGER NOT NULL,
      name         TEXT NOT NULL,
      input_json   TEXT NOT NULL DEFAULT '{}',
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    )
  `);
  raw.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_steps_plan_order
      ON plan_steps(plan_id, step_order)
  `);
  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_plan_steps_status
      ON plan_steps(status)
  `);

  raw.exec(`
    CREATE TABLE IF NOT EXISTS plan_step_runs (
      id              TEXT PRIMARY KEY,
      step_id         TEXT NOT NULL REFERENCES plan_steps(id) ON DELETE CASCADE,
      attempt         INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'running',
      started_at      INTEGER NOT NULL,
      finished_at     INTEGER,
      lifecycle_json  TEXT NOT NULL DEFAULT '[]',
      error_message   TEXT
    )
  `);
  raw.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_step_runs_step_attempt
      ON plan_step_runs(step_id, attempt)
  `);
  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_plan_step_runs_status
      ON plan_step_runs(status)
  `);
  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_plan_step_runs_started
      ON plan_step_runs(started_at)
  `);
}
