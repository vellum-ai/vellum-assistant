import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getSqlite, resetDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  appendRunLifecycle,
  completeStepRun,
  createPlan,
  findStaleRunningSteps,
  getPlanWithSteps,
  listActivePlansForConversation,
  listActivePlansForScope,
  listStepRuns,
  markPlanStatus,
  markStepStatus,
  nextPendingStep,
  recoverStaleRun,
  startStepRun,
  updatePlanStepStatus,
} from "./plan-store.js";

describe("plan-store", () => {
  beforeAll(() => {
    resetDb();
    initializeDb();
  });

  beforeEach(() => {
    const sqlite = getSqlite();
    sqlite.run("DELETE FROM plan_step_runs");
    sqlite.run("DELETE FROM plan_steps");
    sqlite.run("DELETE FROM plans");
  });

  test("createPlan persists plan + ordered steps", () => {
    const { plan, steps } = createPlan({
      goal: "review pull requests",
      conversationId: "conv-1",
      steps: [
        { name: "fetch_open_prs" },
        { name: "rank_by_age", input: { source: "github" } },
      ],
    });
    expect(plan.goal).toBe("review pull requests");
    expect(plan.status).toBe("pending");
    expect(plan.conversationId).toBe("conv-1");
    expect(steps).toHaveLength(2);
    expect(steps[0]!.stepOrder).toBe(0);
    expect(steps[1]!.stepOrder).toBe(1);
    expect(steps[1]!.inputJson).toContain("github");
  });

  test("createPlan rejects empty steps", () => {
    expect(() => createPlan({ goal: "x", steps: [] })).toThrow();
  });

  test("nextPendingStep walks in order and skips completed", () => {
    const { plan } = createPlan({
      goal: "test ordering",
      steps: [{ name: "a" }, { name: "b" }],
    });
    const first = nextPendingStep(plan.id);
    expect(first?.name).toBe("a");

    markStepStatus(first!.id, "completed");
    const second = nextPendingStep(plan.id);
    expect(second?.name).toBe("b");

    markStepStatus(second!.id, "completed");
    expect(nextPendingStep(plan.id)).toBeNull();
  });

  test("startStepRun assigns monotonic attempt numbers per step", () => {
    const { plan } = createPlan({
      goal: "retry test",
      steps: [{ name: "flaky" }],
    });
    const step = nextPendingStep(plan.id)!;

    const first = startStepRun(step.id);
    completeStepRun(first.runId, { status: "failed", error: "transient" });

    const second = startStepRun(step.id);
    expect(second.attempt).toBe(2);
    expect(second.runId).not.toBe(first.runId);

    const runs = listStepRuns(step.id);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.attempt)).toEqual([1, 2]);
  });

  test("appendRunLifecycle appends entries safely", () => {
    const { plan } = createPlan({
      goal: "lifecycle",
      steps: [{ name: "only" }],
    });
    const step = nextPendingStep(plan.id)!;
    const { runId } = startStepRun(step.id);
    appendRunLifecycle(runId, { stage: "started", ts: 1 });
    appendRunLifecycle(runId, { stage: "completed", ts: 2 });

    const runs = listStepRuns(step.id);
    expect(runs).toHaveLength(1);
    const parsed = JSON.parse(runs[0]!.lifecycleJson) as Array<
      Record<string, unknown>
    >;
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toEqual({ stage: "completed", ts: 2 });
  });

  test("findStaleRunningSteps + recoverStaleRun mark stuck runs as recovered", () => {
    const { plan } = createPlan({
      goal: "recovery",
      steps: [{ name: "stuck" }],
    });
    const step = nextPendingStep(plan.id)!;
    const { runId } = startStepRun(step.id);

    const stale = findStaleRunningSteps(Date.now() + 1_000);
    expect(stale.map((s) => s.runId)).toContain(runId);

    recoverStaleRun(runId, "process crashed");
    const runs = listStepRuns(step.id);
    expect(runs[0]!.status).toBe("recovered");
    expect(runs[0]!.errorMessage).toBe("process crashed");

    const stillStale = findStaleRunningSteps(Date.now() + 1_000);
    expect(stillStale.map((s) => s.runId)).not.toContain(runId);
  });

  test("markPlanStatus sets completedAt on terminal states", () => {
    const { plan } = createPlan({
      goal: "terminal",
      steps: [{ name: "x" }],
    });
    markPlanStatus(plan.id, "completed");
    const fresh = getPlanWithSteps(plan.id)!;
    expect(fresh.plan.status).toBe("completed");
    expect(fresh.plan.completedAt).not.toBeNull();
  });

  test("listActivePlansForScope filters pending + running only", () => {
    const a = createPlan({ goal: "active", steps: [{ name: "s" }] });
    const b = createPlan({ goal: "finished", steps: [{ name: "s" }] });
    markPlanStatus(b.plan.id, "completed");

    const active = listActivePlansForScope();
    const ids = active.map((p) => p.id);
    expect(ids).toContain(a.plan.id);
    expect(ids).not.toContain(b.plan.id);
  });

  test("listActivePlansForConversation filters active plans by conversation", () => {
    const active = createPlan({
      goal: "active conversation plan",
      conversationId: "conv-1",
      steps: [{ name: "s" }],
    });
    createPlan({
      goal: "other conversation plan",
      conversationId: "conv-2",
      steps: [{ name: "s" }],
    });
    const finished = createPlan({
      goal: "finished conversation plan",
      conversationId: "conv-1",
      steps: [{ name: "s" }],
    });
    markPlanStatus(finished.plan.id, "completed");

    const plans = listActivePlansForConversation("conv-1");
    expect(plans.map((plan) => plan.id)).toEqual([active.plan.id]);
  });

  test("updatePlanStepStatus stores blocked reason and clears it after progress", () => {
    const { plan, steps } = createPlan({
      goal: "blocked plan",
      steps: [{ name: "wait for choice" }],
    });
    const step = steps[0]!;

    const blocked = updatePlanStepStatus({
      planId: plan.id,
      stepId: step.id,
      status: "blocked",
      blockedReason: "Need branch selection",
    })!;
    expect(blocked.steps[0]!.status).toBe("blocked");
    expect(blocked.steps[0]!.blockedReason).toBe("Need branch selection");

    const running = updatePlanStepStatus({
      planId: plan.id,
      stepId: step.id,
      status: "running",
    })!;
    expect(running.steps[0]!.status).toBe("running");
    expect(running.steps[0]!.blockedReason).toBeNull();
  });

  test("updatePlanStepStatus completes parent plan when every step is complete", () => {
    const { plan, steps } = createPlan({
      goal: "complete parent",
      steps: [{ name: "a" }, { name: "b" }],
    });
    updatePlanStepStatus({
      planId: plan.id,
      stepId: steps[0]!.id,
      status: "completed",
    });
    const done = updatePlanStepStatus({
      planId: plan.id,
      stepId: steps[1]!.id,
      status: "completed",
    })!;
    expect(done.plan.status).toBe("completed");
    expect(done.plan.completedAt).not.toBeNull();
  });
});
