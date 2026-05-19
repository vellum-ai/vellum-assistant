/**
 * Durable store API for the Autonomous Execution Engine.
 *
 * One `plans` row per autonomous goal. Each plan has ordered `plan_steps`,
 * and each step has append-only `plan_step_runs` representing attempts.
 *
 * Shape mirrors `schedule_jobs/_runs` so the crash-recovery pattern from
 * `assistant/src/schedule/schedule-recovery.ts` translates cleanly: stuck
 * runs (status='running' but `started_at` predates the daemon boot) are
 * marked failed/recovered and the parent step is re-enqueued.
 */

import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../memory/db-connection.js";
import {
  type PlanRow,
  plans,
  type PlanStepRow,
  type PlanStepRunRow,
  planStepRuns,
  planSteps,
} from "../memory/schema.js";

const DEFAULT_SCOPE = "default";

export type PlanStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type PlanStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "blocked";

export type PlanStepRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "recovered";

export interface CreatePlanInput {
  scopeId?: string;
  goal: string;
  conversationId?: string;
  steps: Array<{ name: string; input?: Record<string, unknown> }>;
}

export interface UpdatePlanStepStatusInput {
  planId: string;
  stepId: string;
  status: PlanStepStatus;
  blockedReason?: string;
}

export interface PlanWithSteps {
  plan: PlanRow;
  steps: PlanStepRow[];
}

export function createPlan(input: CreatePlanInput): PlanWithSteps {
  if (input.steps.length === 0) {
    throw new Error("createPlan requires at least one step");
  }
  const db = getDb();
  const now = Date.now();
  const planId = uuid();
  const scopeId = input.scopeId ?? DEFAULT_SCOPE;

  db.insert(plans)
    .values({
      id: planId,
      scopeId,
      goal: input.goal,
      status: "pending",
      conversationId: input.conversationId,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const stepRows: PlanStepRow[] = [];
  for (const [order, step] of input.steps.entries()) {
    const stepId = uuid();
    db.insert(planSteps)
      .values({
        id: stepId,
        planId,
        stepOrder: order,
        name: step.name,
        inputJson: JSON.stringify(step.input ?? {}),
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    stepRows.push({
      id: stepId,
      planId,
      stepOrder: order,
      name: step.name,
      inputJson: JSON.stringify(step.input ?? {}),
      status: "pending",
      blockedReason: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const plan = db.select().from(plans).where(eq(plans.id, planId)).get()!;
  return { plan, steps: stepRows };
}

export function getPlanWithSteps(planId: string): PlanWithSteps | null {
  const db = getDb();
  const plan = db.select().from(plans).where(eq(plans.id, planId)).get();
  if (!plan) return null;
  const steps = db
    .select()
    .from(planSteps)
    .where(eq(planSteps.planId, planId))
    .orderBy(asc(planSteps.stepOrder))
    .all();
  return { plan, steps };
}

export function listActivePlansForScope(
  scopeId: string = DEFAULT_SCOPE,
): PlanRow[] {
  const db = getDb();
  return db
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.scopeId, scopeId),
        inArray(plans.status, ["pending", "running"]),
      ),
    )
    .orderBy(desc(plans.updatedAt))
    .all();
}

export function listActivePlansForConversation(
  conversationId: string,
  limit: number = 5,
): PlanRow[] {
  const db = getDb();
  const clamped = Math.max(1, Math.min(limit, 20));
  return db
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.conversationId, conversationId),
        inArray(plans.status, ["pending", "running"]),
      ),
    )
    .orderBy(desc(plans.updatedAt))
    .limit(clamped)
    .all();
}

export function listAllPlansForScope(
  scopeId: string = DEFAULT_SCOPE,
  limit: number = 50,
): PlanRow[] {
  const db = getDb();
  const clamped = Math.max(1, Math.min(limit, 200));
  return db
    .select()
    .from(plans)
    .where(eq(plans.scopeId, scopeId))
    .orderBy(desc(plans.updatedAt))
    .limit(clamped)
    .all();
}

export function markPlanStatus(
  planId: string,
  status: PlanStatus,
  options: { cancellationReason?: string; completedAt?: number } = {},
): void {
  const db = getDb();
  const now = Date.now();
  const update: Partial<typeof plans.$inferInsert> = {
    status,
    updatedAt: now,
  };
  if (options.cancellationReason) {
    update.cancellationReason = options.cancellationReason;
  }
  if (status === "completed" || status === "failed" || status === "cancelled") {
    update.completedAt = options.completedAt ?? now;
  }
  db.update(plans).set(update).where(eq(plans.id, planId)).run();
}

export function markStepStatus(stepId: string, status: PlanStepStatus): void {
  const db = getDb();
  const now = Date.now();
  db.update(planSteps)
    .set({ status, updatedAt: now })
    .where(eq(planSteps.id, stepId))
    .run();
}

export function updatePlanStepStatus(
  input: UpdatePlanStepStatusInput,
): PlanWithSteps | null {
  const found = getPlanWithSteps(input.planId);
  if (!found) return null;
  const step = found.steps.find((candidate) => candidate.id === input.stepId);
  if (!step) return null;

  const terminalPlan =
    found.plan.status === "completed" ||
    found.plan.status === "failed" ||
    found.plan.status === "cancelled";
  if (terminalPlan) {
    throw new Error(`plan is already ${found.plan.status}`);
  }

  const now = Date.now();
  const db = getDb();
  db.update(planSteps)
    .set({
      status: input.status,
      blockedReason:
        input.status === "blocked" ? (input.blockedReason ?? null) : null,
      updatedAt: now,
    })
    .where(eq(planSteps.id, input.stepId))
    .run();

  const refreshed = getPlanWithSteps(input.planId);
  if (!refreshed) return null;

  if (input.status === "blocked") {
    markPlanStatus(input.planId, "running");
  } else if (input.status === "running") {
    markPlanStatus(input.planId, "running");
  } else if (
    refreshed.steps.every((candidate) => candidate.status === "completed")
  ) {
    markPlanStatus(input.planId, "completed");
  } else if (input.status === "failed") {
    markPlanStatus(input.planId, "failed");
  } else {
    db.update(plans)
      .set({ updatedAt: Date.now() })
      .where(eq(plans.id, input.planId))
      .run();
  }

  return getPlanWithSteps(input.planId);
}

export function nextPendingStep(planId: string): PlanStepRow | null {
  const db = getDb();
  return (
    db
      .select()
      .from(planSteps)
      .where(and(eq(planSteps.planId, planId), eq(planSteps.status, "pending")))
      .orderBy(asc(planSteps.stepOrder))
      .limit(1)
      .get() ?? null
  );
}

export function startStepRun(stepId: string): {
  runId: string;
  attempt: number;
} {
  const db = getDb();
  const now = Date.now();

  const last = db
    .select({ maxAttempt: sql<number>`MAX(${planStepRuns.attempt})` })
    .from(planStepRuns)
    .where(eq(planStepRuns.stepId, stepId))
    .get();
  const attempt = (last?.maxAttempt ?? 0) + 1;
  const runId = uuid();
  db.insert(planStepRuns)
    .values({
      id: runId,
      stepId,
      attempt,
      status: "running",
      startedAt: now,
      lifecycleJson: "[]",
    })
    .run();
  markStepStatus(stepId, "running");
  return { runId, attempt };
}

export function appendRunLifecycle(
  runId: string,
  entry: Record<string, unknown>,
): void {
  const db = getDb();
  const row = db
    .select()
    .from(planStepRuns)
    .where(eq(planStepRuns.id, runId))
    .get();
  if (!row) return;
  let log: unknown[];
  try {
    const parsed = JSON.parse(row.lifecycleJson) as unknown;
    log = Array.isArray(parsed) ? parsed : [];
  } catch {
    log = [];
  }
  log.push(entry);
  db.update(planStepRuns)
    .set({ lifecycleJson: JSON.stringify(log) })
    .where(eq(planStepRuns.id, runId))
    .run();
}

export function completeStepRun(
  runId: string,
  result: { status: "completed" } | { status: "failed"; error: string },
): void {
  const db = getDb();
  const now = Date.now();
  db.update(planStepRuns)
    .set({
      status: result.status,
      finishedAt: now,
      errorMessage: result.status === "failed" ? result.error : null,
    })
    .where(eq(planStepRuns.id, runId))
    .run();
}

export function findStaleRunningSteps(
  staleBeforeMs: number,
): Array<{ runId: string; stepId: string; planId: string }> {
  const db = getDb();
  const rows = db
    .select({
      runId: planStepRuns.id,
      stepId: planStepRuns.stepId,
      planId: planSteps.planId,
    })
    .from(planStepRuns)
    .innerJoin(planSteps, eq(planSteps.id, planStepRuns.stepId))
    .where(
      and(
        eq(planStepRuns.status, "running"),
        lte(planStepRuns.startedAt, staleBeforeMs),
      ),
    )
    .all();
  return rows.map((r) => ({
    runId: r.runId,
    stepId: r.stepId,
    planId: r.planId,
  }));
}

export function recoverStaleRun(runId: string, errorMessage: string): void {
  const db = getDb();
  const now = Date.now();
  db.update(planStepRuns)
    .set({
      status: "recovered",
      finishedAt: now,
      errorMessage,
    })
    .where(eq(planStepRuns.id, runId))
    .run();
}

export function listStepRuns(stepId: string): PlanStepRunRow[] {
  const db = getDb();
  return db
    .select()
    .from(planStepRuns)
    .where(eq(planStepRuns.stepId, stepId))
    .orderBy(asc(planStepRuns.attempt))
    .all();
}

export function deletePlanForTest(planId: string): void {
  const db = getDb();
  db.delete(plans).where(eq(plans.id, planId)).run();
}
