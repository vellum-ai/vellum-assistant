import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Autonomous Execution Engine — durable multi-step plan storage.
 *
 * Schema mirrors `schedule_jobs/_runs` so the crash-recovery pattern from
 * `assistant/src/schedule/schedule-recovery.ts` can be replayed against
 * stuck plan step runs at daemon startup.
 *
 * Status enums (validated at the store layer, not by SQLite):
 *   plans.status:           'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
 *   plan_steps.status:      'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked'
 *   plan_step_runs.status:  'running' | 'completed' | 'failed' | 'recovered'
 */
export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull().default("default"),
    goal: text("goal").notNull(),
    status: text("status").notNull().default("pending"),
    conversationId: text("conversation_id"),
    cancellationReason: text("cancellation_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    index("idx_plans_scope_status").on(table.scopeId, table.status),
    index("idx_plans_scope_updated").on(table.scopeId, table.updatedAt),
  ],
);

export const planSteps = sqliteTable(
  "plan_steps",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    stepOrder: integer("step_order").notNull(),
    name: text("name").notNull(),
    inputJson: text("input_json").notNull().default("{}"),
    status: text("status").notNull().default("pending"),
    blockedReason: text("blocked_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_plan_steps_plan_order").on(table.planId, table.stepOrder),
    index("idx_plan_steps_status").on(table.status),
  ],
);

export const planStepRuns = sqliteTable(
  "plan_step_runs",
  {
    id: text("id").primaryKey(),
    stepId: text("step_id")
      .notNull()
      .references(() => planSteps.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull().default("running"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    lifecycleJson: text("lifecycle_json").notNull().default("[]"),
    errorMessage: text("error_message"),
  },
  (table) => [
    uniqueIndex("idx_plan_step_runs_step_attempt").on(
      table.stepId,
      table.attempt,
    ),
    index("idx_plan_step_runs_status").on(table.status),
    index("idx_plan_step_runs_started").on(table.startedAt),
  ],
);

export type PlanRow = typeof plans.$inferSelect;
export type PlanStepRow = typeof planSteps.$inferSelect;
export type PlanStepRunRow = typeof planStepRuns.$inferSelect;
