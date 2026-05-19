import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../memory/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
}));

const { getSqlite, resetDb } = await import("../../memory/db-connection.js");
const { initializeDb } = await import("../../memory/db-init.js");
const { createPlan, markPlanStatus } =
  await import("../../plans/plan-store.js");
const { assistantEventHub } = await import("../assistant-event-hub.js");
const { ROUTES } = await import("./plan-routes.js");
const { BadRequestError, ConflictError, NotFoundError } =
  await import("./errors.js");

function findRoute(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`route not found: ${operationId}`);
  return route;
}

describe("plan-routes", () => {
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

  test("plans_list returns most recently updated plans", () => {
    const { plan: a } = createPlan({ goal: "first", steps: [{ name: "s" }] });
    const { plan: b } = createPlan({ goal: "second", steps: [{ name: "s" }] });
    const result = findRoute("plans_list").handler({}) as {
      plans: Array<{ id: string }>;
    };
    const ids = result.plans.map((p) => p.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  test("plans_get returns plan, steps, and run history", () => {
    const { plan } = createPlan({
      goal: "inspectable",
      steps: [{ name: "a" }, { name: "b" }],
    });
    const result = findRoute("plans_get").handler({
      pathParams: { id: plan.id },
    }) as {
      plan: { id: string };
      steps: Array<{ name: string }>;
      runs: Record<string, unknown>;
    };
    expect(result.plan.id).toBe(plan.id);
    expect(result.steps.map((s) => s.name)).toEqual(["a", "b"]);
    expect(Object.keys(result.runs)).toHaveLength(2);
  });

  test("plans_get throws NotFoundError for missing plan", () => {
    expect(() =>
      findRoute("plans_get").handler({ pathParams: { id: "missing-id" } }),
    ).toThrow(NotFoundError);
  });

  test("plans_create persists a confirmed plan and emits lifecycle", async () => {
    const events: Array<{ type: string; planId?: string }> = [];
    const sub = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        events.push(event.message as { type: string; planId?: string });
      },
    });
    try {
      const result = findRoute("plans_create").handler({
        body: {
          goal: "ship focused slice",
          conversationId: "conv-1",
          steps: [{ name: "write tests" }, { name: "run tests" }],
        },
      }) as {
        plan: { id: string; goal: string };
        steps: Array<{ name: string }>;
      };
      await Promise.resolve();
      expect(result.plan.goal).toBe("ship focused slice");
      expect(result.steps.map((step) => step.name)).toEqual([
        "write tests",
        "run tests",
      ]);
      expect(
        events.some(
          (event) =>
            event.type === "plan_lifecycle" && event.planId === result.plan.id,
        ),
      ).toBe(true);
    } finally {
      sub.dispose();
    }
  });

  test("plans_cancel flips status and records reason", () => {
    const { plan } = createPlan({ goal: "cancel me", steps: [{ name: "x" }] });
    const result = findRoute("plans_cancel").handler({
      pathParams: { id: plan.id },
      body: { reason: "user requested" },
    }) as {
      plan: { status: string; cancellationReason: string | null };
      cancelled: boolean;
    };
    expect(result.cancelled).toBe(true);
    expect(result.plan.status).toBe("cancelled");
    expect(result.plan.cancellationReason).toBe("user requested");
  });

  test("plans_cancel is no-op for already terminal plan", () => {
    const { plan } = createPlan({ goal: "done", steps: [{ name: "x" }] });
    markPlanStatus(plan.id, "completed");
    const result = findRoute("plans_cancel").handler({
      pathParams: { id: plan.id },
      body: {},
    }) as { plan: { status: string }; cancelled: boolean };
    expect(result.cancelled).toBe(false);
    expect(result.plan.status).toBe("completed");
  });

  test("plans_list rejects non-positive limit", () => {
    expect(() =>
      findRoute("plans_list").handler({ queryParams: { limit: "0" } }),
    ).toThrow(BadRequestError);
  });

  test("plans_step_update_status records blocked reason", () => {
    const { plan, steps } = createPlan({
      goal: "blocked route",
      steps: [{ name: "ask user" }],
    });
    const result = findRoute("plans_step_update_status").handler({
      pathParams: { id: plan.id, stepId: steps[0]!.id },
      body: {
        status: "blocked",
        blockedReason: "Need confirmation",
      },
    }) as {
      step: { status: string; blockedReason: string | null };
    };
    expect(result.step.status).toBe("blocked");
    expect(result.step.blockedReason).toBe("Need confirmation");
  });

  test("plans_step_update_status requires blocked reason", () => {
    const { plan, steps } = createPlan({
      goal: "blocked route",
      steps: [{ name: "ask user" }],
    });
    expect(() =>
      findRoute("plans_step_update_status").handler({
        pathParams: { id: plan.id, stepId: steps[0]!.id },
        body: { status: "blocked" },
      }),
    ).toThrow(BadRequestError);
  });

  test("plans_step_update_status rejects terminal parent plans", () => {
    const { plan, steps } = createPlan({
      goal: "done",
      steps: [{ name: "x" }],
    });
    markPlanStatus(plan.id, "completed");
    expect(() =>
      findRoute("plans_step_update_status").handler({
        pathParams: { id: plan.id, stepId: steps[0]!.id },
        body: { status: "running" },
      }),
    ).toThrow(ConflictError);
  });
});
