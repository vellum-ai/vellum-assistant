import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../memory/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
}));

const { getSqlite, resetDb } = await import("../memory/db-connection.js");
const { initializeDb } = await import("../memory/db-init.js");
const {
  createPlan,
  getPlanWithSteps,
  listStepRuns,
  markPlanStatus,
  nextPendingStep,
  startStepRun,
} = await import("./plan-store.js");
const { recoverStalePlans } = await import("./recovery.js");
const { runPlan } = await import("./run-plan.js");

describe("recoverStalePlans", () => {
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

  test("no-ops when no stale runs exist", () => {
    expect(recoverStalePlans()).toBe(0);
  });

  test("recovers running step runs and demotes parent plan + step", () => {
    const { plan } = createPlan({
      goal: "interrupted",
      steps: [{ name: "a" }, { name: "b" }],
    });
    markPlanStatus(plan.id, "running");
    const step = nextPendingStep(plan.id)!;
    const { runId } = startStepRun(step.id);

    expect(recoverStalePlans(Date.now() + 1_000)).toBe(1);

    const runs = listStepRuns(step.id);
    expect(runs[0]!.id).toBe(runId);
    expect(runs[0]!.status).toBe("recovered");
    expect(runs[0]!.errorMessage).toContain("Process terminated");

    const fresh = getPlanWithSteps(plan.id)!;
    expect(fresh.plan.status).toBe("pending");
    expect(fresh.steps[0]!.status).toBe("pending");
    expect(fresh.steps[1]!.status).toBe("pending");
  });

  test("recovered plan can be re-run successfully", async () => {
    const { plan } = createPlan({
      goal: "resume after crash",
      steps: [{ name: "a" }, { name: "b" }],
    });

    // Simulate a crash: mark plan running and start the first step run.
    markPlanStatus(plan.id, "running");
    const stepA = nextPendingStep(plan.id)!;
    startStepRun(stepA.id);

    // Recover at boot.
    recoverStalePlans(Date.now() + 1_000);

    // Run again — should walk both steps cleanly.
    const dispatched: string[] = [];
    const result = await runPlan({
      planId: plan.id,
      dispatch: async (ctx) => {
        dispatched.push(ctx.step.name);
        return { ok: true };
      },
    });
    expect(result.status).toBe("completed");
    expect(dispatched).toEqual(["a", "b"]);

    // First step now has TWO attempts: the recovered one + the resume.
    const runs = listStepRuns(stepA.id);
    expect(runs.map((r) => r.status)).toEqual(["recovered", "completed"]);
  });

  test("ignores cancelled and completed plans", () => {
    const ok = createPlan({ goal: "done", steps: [{ name: "x" }] });
    markPlanStatus(ok.plan.id, "completed");

    const cancelled = createPlan({ goal: "stop", steps: [{ name: "x" }] });
    markPlanStatus(cancelled.plan.id, "cancelled");

    expect(recoverStalePlans()).toBe(0);

    expect(getPlanWithSteps(ok.plan.id)!.plan.status).toBe("completed");
    expect(getPlanWithSteps(cancelled.plan.id)!.plan.status).toBe("cancelled");
  });
});
