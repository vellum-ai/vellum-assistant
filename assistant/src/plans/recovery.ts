/**
 * Crash recovery for the Autonomous Execution Engine.
 *
 * Called once at daemon startup, before the agent loop boots. Any
 * `plan_step_runs` left in `status='running'` predate this process and
 * are definitively stale; we mark them as `recovered` and roll the
 * parent step back to `pending` so the next runner invocation can retry.
 *
 * Mirrors `assistant/src/schedule/schedule-recovery.ts` — same pattern,
 * narrower domain.
 */

import { eq, inArray } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { plans, planSteps } from "../memory/schema.js";
import { getLogger } from "../util/logger.js";
import {
  findStaleRunningSteps,
  markPlanStatus,
  markStepStatus,
  recoverStaleRun,
} from "./plan-store.js";

const log = getLogger("plans:recovery");

/**
 * Reset stuck step runs and demote their parent steps + plans back to
 * `pending` / `running`. Returns the number of step runs recovered.
 *
 * Safe to call when no plan rows exist (returns 0).
 */
export function recoverStalePlans(now: number = Date.now()): number {
  const stale = findStaleRunningSteps(now);
  if (stale.length === 0) return 0;

  log.info({ count: stale.length }, "Recovering stale plan step runs");

  const errorMsg =
    "Process terminated during step execution (recovered on restart)";
  const recoveredPlans = new Set<string>();

  for (const { runId, stepId, planId } of stale) {
    try {
      recoverStaleRun(runId, errorMsg);
      markStepStatus(stepId, "pending");
      recoveredPlans.add(planId);
    } catch (err) {
      log.error(
        { err, runId, stepId, planId },
        "Failed to recover stale plan run",
      );
    }
  }

  // Demote each affected plan back to "pending" so the runner can pick
  // it up again. We intentionally don't preserve the "running" state —
  // the resumed runner will re-emit "started"/"running" lifecycle events.
  if (recoveredPlans.size > 0) {
    const db = getDb();
    const rows = db
      .select({ id: plans.id, status: plans.status })
      .from(plans)
      .where(inArray(plans.id, Array.from(recoveredPlans)))
      .all();
    for (const row of rows) {
      if (row.status === "running" || row.status === "pending") {
        markPlanStatus(row.id, "pending");
      }
    }
  }

  // Defensive: any plan_steps still in `running` whose run was not in the
  // stale set (theoretically impossible) — demote them too. This belt-and-
  // suspenders pass keeps an inconsistent schema from blocking the next
  // runner invocation.
  const db = getDb();
  const stuckSteps = db
    .select({ id: planSteps.id })
    .from(planSteps)
    .where(eq(planSteps.status, "running"))
    .all();
  for (const s of stuckSteps) {
    markStepStatus(s.id, "pending");
  }

  log.info({ recovered: stale.length }, "Stale plan run recovery complete");
  return stale.length;
}
