import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AssistantConfig } from "../../config/schema.js";
import type { WorkflowRun } from "../../workflows/journal-store.js";
import type { SavedWorkflowEntry } from "../../workflows/library.js";
import { NotFoundError } from "./errors.js";
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
}

function setup(opts: {
  flagEnabled?: boolean;
  runs?: WorkflowRun[];
  saved?: SavedWorkflowEntry[];
}): {
  aborted: string[];
  listCalls: Array<{ limit?: number; status?: string }>;
} {
  const runs = opts.runs ?? [];
  const aborted: string[] = [];
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
  };
  __setWorkflowRoutesDeps({
    getManager: () => manager,
    listWorkflows: () => opts.saved ?? [],
    getConfig: () => ({}) as AssistantConfig,
    isFlagEnabled: () => opts.flagEnabled ?? true,
  });
  return { aborted, listCalls };
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
    ["listSavedWorkflows", {}],
  ] as const)("%s throws NotFoundError when the flag is off", (op, args) => {
    expect(() => route(op).handler(args)).toThrow(NotFoundError);
  });
});
