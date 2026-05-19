import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../memory/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
}));

const { getSqlite, resetDb } = await import("../memory/db-connection.js");
const { initializeDb } = await import("../memory/db-init.js");
const { createPlan, getPlanWithSteps, listStepRuns, markPlanStatus } =
  await import("./plan-store.js");
const { runPlan } = await import("./run-plan.js");

describe("runPlan", () => {
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

  test("walks steps in order, marks plan completed, emits lifecycle", async () => {
    const { plan } = createPlan({
      goal: "happy path",
      conversationId: "conv-7",
      steps: [{ name: "step_a", input: { a: 1 } }, { name: "step_b" }],
    });

    const planStages: string[] = [];
    const stepStages: string[] = [];
    const dispatched: string[] = [];

    const result = await runPlan({
      planId: plan.id,
      dispatch: async (ctx) => {
        dispatched.push(`${ctx.step.order}:${ctx.step.name}`);
        return { ok: true };
      },
      onPlanLifecycle: (event) => planStages.push(event.stage),
      onStepLifecycle: (event) =>
        stepStages.push(`${event.stepOrder}:${event.stage}`),
    });

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toBe(2);
    expect(dispatched).toEqual(["0:step_a", "1:step_b"]);
    expect(planStages).toEqual(["started", "running", "completed"]);
    expect(stepStages.filter((s) => s.endsWith(":completed"))).toEqual([
      "0:completed",
      "1:completed",
    ]);

    const fresh = getPlanWithSteps(plan.id)!;
    expect(fresh.plan.status).toBe("completed");
    expect(fresh.steps.every((s) => s.status === "completed")).toBe(true);
  });

  test("stops on first failure, marks plan failed, records error", async () => {
    const { plan } = createPlan({
      goal: "sad path",
      steps: [{ name: "a" }, { name: "b" }, { name: "c" }],
    });

    const planStages: string[] = [];
    const result = await runPlan({
      planId: plan.id,
      dispatch: async (ctx) => {
        if (ctx.step.name === "b") return { ok: false, error: "boom" };
        return { ok: true };
      },
      onPlanLifecycle: (event) => planStages.push(event.stage),
    });

    expect(result.status).toBe("failed");
    expect(result.completedSteps).toBe(1);
    expect(result.errorMessage).toBe("boom");
    expect(planStages.at(-1)).toBe("failed");

    const fresh = getPlanWithSteps(plan.id)!;
    expect(fresh.plan.status).toBe("failed");
    const statuses = fresh.steps.map((s) => s.status);
    expect(statuses).toEqual(["completed", "failed", "pending"]);
  });

  test("dispatch errors are caught and surface as failed", async () => {
    const { plan } = createPlan({
      goal: "throwing dispatch",
      steps: [{ name: "throws" }],
    });
    const result = await runPlan({
      planId: plan.id,
      dispatch: async () => {
        throw new Error("explode");
      },
    });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("explode");

    const fresh = getPlanWithSteps(plan.id)!;
    expect(fresh.steps[0]!.status).toBe("failed");
    const runs = listStepRuns(fresh.steps[0]!.id);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.errorMessage).toBe("explode");
  });

  test("cancels plan when status flips mid-run", async () => {
    const { plan } = createPlan({
      goal: "cancellable",
      steps: [{ name: "first" }, { name: "second" }, { name: "third" }],
    });
    let dispatched = 0;
    const result = await runPlan({
      planId: plan.id,
      dispatch: async () => {
        dispatched += 1;
        if (dispatched === 1) {
          markPlanStatus(plan.id, "cancelled", { cancellationReason: "user" });
        }
        return { ok: true };
      },
    });
    expect(result.status).toBe("cancelled");
    expect(dispatched).toBe(1);

    const fresh = getPlanWithSteps(plan.id)!;
    expect(fresh.plan.status).toBe("cancelled");
    expect(fresh.plan.cancellationReason).toBe("user");
  });

  test("abort signal cancels before first step", async () => {
    const { plan } = createPlan({
      goal: "abort first",
      steps: [{ name: "a" }],
    });
    const controller = new AbortController();
    controller.abort();
    const result = await runPlan({
      planId: plan.id,
      signal: controller.signal,
      dispatch: async () => ({ ok: true }),
    });
    expect(result.status).toBe("cancelled");
    expect(result.completedSteps).toBe(0);
  });
});
