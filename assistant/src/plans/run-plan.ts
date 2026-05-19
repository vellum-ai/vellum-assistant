/**
 * Stepwise plan runner — the executor side of the Autonomous Execution Engine.
 *
 * `runPlan` walks the pending steps of a plan in order, invoking a caller-
 * supplied `dispatch(step)` for each. Each step is wrapped with `runAction`
 * so audit-log and lifecycle invariants remain uniform with one-shot host
 * actions, and `plan_lifecycle` / `plan_step_lifecycle` messages are
 * broadcast for connected clients (e.g. Tauri HUD).
 *
 * The runner only persists state via `plan-store`. Crash recovery is
 * external: `assistant/src/plans/recovery.ts` resets stuck `plan_step_runs`
 * on daemon boot and the runner is re-invoked.
 */

import { runAction } from "../actions/run-action.js";
import { getLogger } from "../util/logger.js";
import {
  appendRunLifecycle,
  completeStepRun,
  getPlanWithSteps,
  markPlanStatus,
  markStepStatus,
  nextPendingStep,
  type PlanWithSteps,
  startStepRun,
} from "./plan-store.js";

const log = getLogger("plans:runner");

export type PlanStepLifecycleStage =
  | "started"
  | "executing"
  | "completed"
  | "failed"
  | "blocked";

export type PlanLifecycleStage =
  | "started"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface PlanLifecycleEvent {
  planId: string;
  goal: string;
  stage: PlanLifecycleStage;
  ts: number;
  conversationId?: string;
  message?: string;
}

export interface PlanStepLifecycleEvent {
  planId: string;
  stepId: string;
  stepOrder: number;
  stepName: string;
  attempt: number;
  stage: PlanStepLifecycleStage;
  ts: number;
  conversationId?: string;
  message?: string;
}

export interface PlanDispatchContext {
  planId: string;
  step: {
    id: string;
    name: string;
    order: number;
    input: Record<string, unknown>;
  };
  attempt: number;
  runId: string;
  conversationId?: string;
}

export type PlanDispatchFn = (
  ctx: PlanDispatchContext,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export interface RunPlanOptions {
  planId: string;
  dispatch: PlanDispatchFn;
  onPlanLifecycle?: (event: PlanLifecycleEvent) => void;
  onStepLifecycle?: (event: PlanStepLifecycleEvent) => void;
  /** Optional abort signal to interrupt the runner between steps. */
  signal?: AbortSignal;
}

export interface RunPlanResult {
  status: "completed" | "failed" | "cancelled";
  completedSteps: number;
  failedStepId?: string;
  errorMessage?: string;
}

export async function runPlan(options: RunPlanOptions): Promise<RunPlanResult> {
  const initial = getPlanWithSteps(options.planId);
  if (!initial) {
    throw new Error(`runPlan: plan not found ${options.planId}`);
  }
  if (initial.plan.status === "cancelled") {
    return { status: "cancelled", completedSteps: 0 };
  }

  emitPlanLifecycle(options, initial, "started");
  markPlanStatus(options.planId, "running");
  emitPlanLifecycle(options, initial, "running");

  let completedSteps = 0;
  while (true) {
    if (options.signal?.aborted) {
      markPlanStatus(options.planId, "cancelled", {
        cancellationReason: "abort_signal",
      });
      emitPlanLifecycle(options, initial, "cancelled");
      return { status: "cancelled", completedSteps };
    }

    const refreshed = getPlanWithSteps(options.planId);
    if (!refreshed) {
      return { status: "failed", completedSteps, errorMessage: "plan_deleted" };
    }
    if (refreshed.plan.status === "cancelled") {
      emitPlanLifecycle(options, refreshed, "cancelled");
      return { status: "cancelled", completedSteps };
    }

    const step = nextPendingStep(options.planId);
    if (!step) {
      markPlanStatus(options.planId, "completed");
      emitPlanLifecycle(options, refreshed, "completed");
      return { status: "completed", completedSteps };
    }

    const { runId, attempt } = startStepRun(step.id);

    let parsedInput: Record<string, unknown>;
    try {
      const candidate = JSON.parse(step.inputJson) as unknown;
      parsedInput =
        candidate && typeof candidate === "object" && !Array.isArray(candidate)
          ? (candidate as Record<string, unknown>)
          : {};
    } catch {
      parsedInput = {};
    }

    const ctx: PlanDispatchContext = {
      planId: options.planId,
      step: {
        id: step.id,
        name: step.name,
        order: step.stepOrder,
        input: parsedInput,
      },
      attempt,
      runId,
      ...(refreshed.plan.conversationId
        ? { conversationId: refreshed.plan.conversationId }
        : {}),
    };

    emitStepLifecycle(options, ctx, "started");

    let dispatchResult: { ok: true } | { ok: false; error: string };
    try {
      dispatchResult = await runAction<
        { ok: true } | { ok: false; error: string }
      >({
        actionName: `plan:${step.name}`,
        conversationId: refreshed.plan.conversationId ?? "plan",
        inputSummary: JSON.stringify({ planId: options.planId, attempt }),
        riskLevel: "Medium",
        execute: async () => {
          emitStepLifecycle(options, ctx, "executing");
          appendRunLifecycle(runId, {
            stage: "executing",
            ts: Date.now(),
          });
          return await options.dispatch(ctx);
        },
      });
    } catch (err) {
      dispatchResult = { ok: false, error: errorMessage(err) };
    }

    if (dispatchResult.ok) {
      completeStepRun(runId, { status: "completed" });
      markStepStatus(step.id, "completed");
      appendRunLifecycle(runId, { stage: "completed", ts: Date.now() });
      emitStepLifecycle(options, ctx, "completed");
      completedSteps += 1;
      continue;
    }

    completeStepRun(runId, { status: "failed", error: dispatchResult.error });
    markStepStatus(step.id, "failed");
    appendRunLifecycle(runId, {
      stage: "failed",
      ts: Date.now(),
      message: dispatchResult.error,
    });
    emitStepLifecycle(options, ctx, "failed", dispatchResult.error);
    markPlanStatus(options.planId, "failed");
    emitPlanLifecycle(options, refreshed, "failed", dispatchResult.error);
    return {
      status: "failed",
      completedSteps,
      failedStepId: step.id,
      errorMessage: dispatchResult.error,
    };
  }
}

function emitPlanLifecycle(
  options: RunPlanOptions,
  plan: PlanWithSteps,
  stage: PlanLifecycleStage,
  message?: string,
): void {
  if (!options.onPlanLifecycle) return;
  try {
    options.onPlanLifecycle({
      planId: plan.plan.id,
      goal: plan.plan.goal,
      stage,
      ts: Date.now(),
      ...(plan.plan.conversationId
        ? { conversationId: plan.plan.conversationId }
        : {}),
      ...(message ? { message } : {}),
    });
  } catch (err) {
    log.warn(
      { err, planId: plan.plan.id, stage },
      "plan lifecycle subscriber failed",
    );
  }
}

function emitStepLifecycle(
  options: RunPlanOptions,
  ctx: PlanDispatchContext,
  stage: PlanStepLifecycleStage,
  message?: string,
): void {
  if (!options.onStepLifecycle) return;
  try {
    options.onStepLifecycle({
      planId: ctx.planId,
      stepId: ctx.step.id,
      stepOrder: ctx.step.order,
      stepName: ctx.step.name,
      attempt: ctx.attempt,
      stage,
      ts: Date.now(),
      ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
      ...(message ? { message } : {}),
    });
  } catch (err) {
    log.warn(
      { err, planId: ctx.planId, stepId: ctx.step.id, stage },
      "step lifecycle subscriber failed",
    );
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown plan dispatch error";
}
