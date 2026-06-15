import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AssistantConfig } from "../../config/schema.js";
import type { WorkflowRun } from "../../workflows/journal-store.js";
import type { SavedWorkflowEntry } from "../../workflows/library.js";
import {
  WorkflowResumeNotPossibleError,
  WorkflowRunCapError,
} from "../../workflows/run-manager.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
} from "./errors.js";
import type { RouteDefinition } from "./types.js";
import { __setWorkflowRoutesDeps, ROUTES } from "./workflow-routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function route(operationId: string): RouteDefinition {
  const r = ROUTES.find((x) => x.operationId === operationId);
  if (!r) throw new Error(`No route for ${operationId}`);
  return r;
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    name: "demo",
    scriptSource: "export const meta = { name: 'demo' }",
    scriptHash: "hash-1",
    args: null,
    capabilities: null,
    status: "running",
    conversationId: null,
    trust: null,
    agentsSpawned: 2,
    inputTokens: 10,
    outputTokens: 5,
    result: null,
    error: null,
    createdAt: 1000,
    updatedAt: 2000,
    finishedAt: null,
    ...overrides,
  };
}

interface FakeManager {
  list: (opts?: {
    limit?: number;
    status?: WorkflowRun["status"];
  }) => WorkflowRun[];
  status: (id: string) => WorkflowRun | null;
  abort: (id: string) => void;
  resume: (id: string) => { runId: string };
}

function setup(opts: {
  flagEnabled?: boolean;
  runs?: WorkflowRun[];
  saved?: SavedWorkflowEntry[];
  /** Custom resume impl; defaults to a success that records the id. */
  resume?: (id: string) => { runId: string };
}): {
  aborted: string[];
  resumed: string[];
  listCalls: Array<{ limit?: number; status?: string }>;
} {
  const runs = opts.runs ?? [];
  const aborted: string[] = [];
  const resumed: string[] = [];
  const listCalls: Array<{ limit?: number; status?: string }> = [];
  const manager: FakeManager = {
    list: (o) => {
      listCalls.push({ limit: o?.limit, status: o?.status });
      let result = runs;
      if (o?.status) result = result.filter((r) => r.status === o.status);
      if (o?.limit !== undefined) result = result.slice(0, o.limit);
      return result;
    },
    status: (id) => runs.find((r) => r.id === id) ?? null,
    abort: (id) => {
      aborted.push(id);
    },
    resume:
      opts.resume ??
      ((id) => {
        resumed.push(id);
        return { runId: id };
      }),
  };
  __setWorkflowRoutesDeps({
    getManager: () => manager,
    listWorkflows: () => opts.saved ?? [],
    getConfig: () => ({}) as AssistantConfig,
    isFlagEnabled: () => opts.flagEnabled ?? true,
  });
  return { aborted, resumed, listCalls };
}

afterEach(() => {
  __setWorkflowRoutesDeps();
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("workflow routes (flag on)", () => {
  beforeEach(() => {
    setup({
      flagEnabled: true,
      runs: [
        makeRun({ id: "run-1" }),
        makeRun({ id: "run-2", status: "completed" }),
      ],
      saved: [
        {
          name: "nightly",
          description: "Nightly job",
          path: "/w/nightly.workflow.ts",
        },
      ],
    });
  });

  test("listWorkflowRuns returns wire runs", async () => {
    const result = (await route("listWorkflowRuns").handler({
      queryParams: {},
    })) as {
      runs: Array<{ id: string; scriptHash: string }>;
    };
    expect(result.runs.map((r) => r.id)).toEqual(["run-1", "run-2"]);
    // Bulky fields are dropped from the wire shape.
    expect(result.runs[0]).not.toHaveProperty("scriptSource");
    expect(result.runs[0].scriptHash).toBe("hash-1");
  });

  test("listWorkflowRuns honors limit + status query params", async () => {
    const { listCalls } = setup({
      flagEnabled: true,
      runs: [makeRun({ id: "run-1", status: "completed" })],
    });
    await route("listWorkflowRuns").handler({
      queryParams: { limit: "5", status: "completed" },
    });
    expect(listCalls.at(-1)).toEqual({ limit: 5, status: "completed" });
  });

  test("getWorkflowRun returns a single run", async () => {
    const result = (await route("getWorkflowRun").handler({
      pathParams: { id: "run-1" },
    })) as { id: string };
    expect(result.id).toBe("run-1");
  });

  test("abortWorkflowRun aborts a known run", async () => {
    const { aborted } = setup({
      flagEnabled: true,
      runs: [makeRun({ id: "run-1" })],
    });
    const result = (await route("abortWorkflowRun").handler({
      pathParams: { id: "run-1" },
    })) as { ok: boolean; runId: string };
    expect(result).toEqual({ ok: true, runId: "run-1" });
    expect(aborted).toEqual(["run-1"]);
  });

  test("resumeWorkflowRun resumes an interrupted run", async () => {
    const { resumed } = setup({
      flagEnabled: true,
      runs: [makeRun({ id: "run-1", status: "interrupted" })],
    });
    const result = (await route("resumeWorkflowRun").handler({
      pathParams: { id: "run-1" },
    })) as { ok: boolean; runId: string };
    expect(result).toEqual({ ok: true, runId: "run-1" });
    expect(resumed).toEqual(["run-1"]);
  });

  test("resumeWorkflowRun rejects a side-effecting run with a 403 (no prompt channel)", () => {
    // The run's stored manifest grants side-effecting tools, so resuming would
    // restart leaves that perform them. This route has no interactive approval
    // channel (unlike the conversational manage_workflows path), so it must
    // refuse rather than silently bypass consent — resume() is never called.
    const { resumed } = setup({
      flagEnabled: true,
      runs: [
        makeRun({
          id: "run-1",
          status: "interrupted",
          capabilities: { tools: ["bash"], hostFunctions: [], persona: false },
        }),
      ],
    });
    expect(() =>
      route("resumeWorkflowRun").handler({ pathParams: { id: "run-1" } }),
    ).toThrow(ForbiddenError);
    expect(resumed).toEqual([]);
  });

  test("resumeWorkflowRun rejects a run stored in the older RESOLVED shape", () => {
    // Some interrupted runs persisted resolved Tool objects (not string names).
    // resume() recovers those names and grants the tools, so the gate must catch
    // the object shape too — a strict parse would treat it as read-only and let
    // the side-effecting resume through without approval.
    const { resumed } = setup({
      flagEnabled: true,
      runs: [
        makeRun({
          id: "run-1",
          status: "interrupted",
          capabilities: { tools: [{ name: "bash" }] } as unknown as Record<
            string,
            unknown
          >,
        }),
      ],
    });
    expect(() =>
      route("resumeWorkflowRun").handler({ pathParams: { id: "run-1" } }),
    ).toThrow(ForbiddenError);
    expect(resumed).toEqual([]);
  });

  test("resumeWorkflowRun allows a read-only run (empty manifest)", () => {
    // An explicit empty manifest grants no side effects, so the route resumes
    // it directly — the gate keys on the stored manifest, not run existence.
    const { resumed } = setup({
      flagEnabled: true,
      runs: [
        makeRun({
          id: "run-1",
          status: "interrupted",
          capabilities: { tools: [], hostFunctions: [], persona: false },
        }),
      ],
    });
    route("resumeWorkflowRun").handler({ pathParams: { id: "run-1" } });
    expect(resumed).toEqual(["run-1"]);
  });

  test("resumeWorkflowRun maps a non-interrupted run to a 409 ConflictError", () => {
    setup({
      flagEnabled: true,
      runs: [makeRun({ id: "run-1", status: "completed" })],
      resume: (id) => {
        throw new WorkflowResumeNotPossibleError(
          id,
          "not_interrupted",
          "completed",
        );
      },
    });
    expect(() =>
      route("resumeWorkflowRun").handler({ pathParams: { id: "run-1" } }),
    ).toThrow(ConflictError);
  });

  test("resumeWorkflowRun maps a cap error to a 429 TooManyRequestsError", () => {
    setup({
      flagEnabled: true,
      runs: [makeRun({ id: "run-1", status: "interrupted" })],
      resume: () => {
        throw new WorkflowRunCapError(3);
      },
    });
    expect(() =>
      route("resumeWorkflowRun").handler({ pathParams: { id: "run-1" } }),
    ).toThrow(TooManyRequestsError);
  });

  test("listSavedWorkflows returns saved entries", async () => {
    const result = (await route("listSavedWorkflows").handler({})) as {
      workflows: SavedWorkflowEntry[];
    };
    expect(result.workflows).toEqual([
      {
        name: "nightly",
        description: "Nightly job",
        path: "/w/nightly.workflow.ts",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Unknown run → 404
// ---------------------------------------------------------------------------

describe("workflow routes (unknown run)", () => {
  test("getWorkflowRun throws NotFoundError for an unknown id", () => {
    setup({ flagEnabled: true, runs: [] });
    expect(() =>
      route("getWorkflowRun").handler({ pathParams: { id: "nope" } }),
    ).toThrow(NotFoundError);
  });

  test("abortWorkflowRun throws NotFoundError for an unknown id", () => {
    const { aborted } = setup({ flagEnabled: true, runs: [] });
    expect(() =>
      route("abortWorkflowRun").handler({ pathParams: { id: "nope" } }),
    ).toThrow(NotFoundError);
    expect(aborted).toEqual([]);
  });

  test("resumeWorkflowRun throws NotFoundError for an unknown id", () => {
    const { resumed } = setup({ flagEnabled: true, runs: [] });
    expect(() =>
      route("resumeWorkflowRun").handler({ pathParams: { id: "nope" } }),
    ).toThrow(NotFoundError);
    expect(resumed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Flag off → every route 404s
// ---------------------------------------------------------------------------

describe("workflow routes (flag off)", () => {
  beforeEach(() => {
    setup({ flagEnabled: false, runs: [makeRun({ id: "run-1" })], saved: [] });
  });

  test.each([
    ["listWorkflowRuns", { queryParams: {} }],
    ["getWorkflowRun", { pathParams: { id: "run-1" } }],
    ["abortWorkflowRun", { pathParams: { id: "run-1" } }],
    ["resumeWorkflowRun", { pathParams: { id: "run-1" } }],
    ["listSavedWorkflows", {}],
  ] as const)("%s throws NotFoundError when the flag is off", (op, args) => {
    expect(() => route(op).handler(args)).toThrow(NotFoundError);
  });
});
