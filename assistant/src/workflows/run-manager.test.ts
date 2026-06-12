import { describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { AssistantConfig } from "../config/schema.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type { ExecuteWorkflowOptions } from "./engine.js";
import { WorkflowNotFoundError } from "./engine.js";
import type {
  CreateRunInput,
  WorkflowRun,
  WorkflowRunStatus,
} from "./journal-store.js";
import {
  WorkflowRunCapError,
  WorkflowRunManager,
  type WorkflowRunManagerDeps,
  WorkflowsDisabledError,
} from "./run-manager.js";

const TRUST: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

/** Minimal config exposing only the fields the manager reads. */
function makeConfig(maxConcurrentRuns = 3): AssistantConfig {
  return {
    workflows: {
      maxAgentsPerRun: 500,
      maxConcurrentLeaves: 6,
      maxConcurrentRuns,
      journalRetentionDays: 30,
    },
  } as unknown as AssistantConfig;
}

/**
 * In-memory journal store standing in for `./journal-store.js`. Implements only
 * the surface the manager touches (`createRun`, `getRun`, `listRuns`) plus the
 * engine's surface (unused here since we also fake the engine).
 */
function makeFakeJournal() {
  const rows = new Map<string, WorkflowRun>();
  const setStats = (id: string, patch: Partial<WorkflowRun>): void => {
    const existing = rows.get(id);
    if (existing) rows.set(id, { ...existing, ...patch });
  };
  return {
    rows,
    setStats,
    journal: {
      createRun: (input: CreateRunInput): WorkflowRun => {
        const run: WorkflowRun = {
          id: input.id,
          name: input.name ?? null,
          scriptSource: input.scriptSource,
          scriptHash: input.scriptHash,
          args: input.args ?? null,
          capabilities: input.capabilities ?? null,
          status: input.status ?? "running",
          conversationId: input.conversationId ?? null,
          agentsSpawned: 0,
          inputTokens: 0,
          outputTokens: 0,
          result: null,
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          finishedAt: null,
        };
        rows.set(input.id, run);
        return run;
      },
      getRun: (id: string): WorkflowRun | null => rows.get(id) ?? null,
      listRuns: ({
        limit,
        status,
      }: {
        limit: number;
        status?: WorkflowRunStatus;
      }): WorkflowRun[] => {
        const all = [...rows.values()].sort(
          (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
        );
        return (status ? all.filter((r) => r.status === status) : all).slice(
          0,
          limit,
        );
      },
    } as unknown as WorkflowRunManagerDeps["journal"],
  };
}

interface ManagerHarness {
  manager: WorkflowRunManager;
  executeCalls: ExecuteWorkflowOptions[];
  broadcasts: Array<{ type: string; [k: string]: unknown }>;
  wakes: Array<{ conversationId: string; hint: string; source: string }>;
  fake: ReturnType<typeof makeFakeJournal>;
  /** Resolve the latest in-flight engine run with a given result. */
  resolveLatest: (result: EngineResult) => Promise<void>;
}

interface EngineResult {
  status: WorkflowRunStatus;
  result: unknown;
  agentsSpawned: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Build a manager with a fully-injected, provider-free seam: a fake engine that
 * surfaces a resolver hook (so a test can drive progress/abort/completion
 * deterministically), an in-memory journal, and spies for broadcast + wake.
 */
function makeHarness(opts?: {
  flagEnabled?: boolean;
  maxConcurrentRuns?: number;
  /** Custom engine impl; defaults to the deferred-resolver fake. */
  engine?: WorkflowRunManagerDeps["executeWorkflow"];
  /** Saved-workflow resolver for the `start({ name })` path. */
  getWorkflow?: WorkflowRunManagerDeps["getWorkflow"];
}): ManagerHarness {
  const fake = makeFakeJournal();
  const executeCalls: ExecuteWorkflowOptions[] = [];
  const broadcasts: ManagerHarness["broadcasts"] = [];
  const wakes: ManagerHarness["wakes"] = [];

  // Deferred-resolution engine: capture each invocation and let the test settle
  // it. Tracks the resolver so `resolveLatest` can fire completion on demand.
  const resolvers: Array<(r: EngineResult) => void> = [];
  const defaultEngine: WorkflowRunManagerDeps["executeWorkflow"] = (
    options,
  ) => {
    executeCalls.push(options);
    // Reflect the engine's count-flushing so `getRun` mirrors mid-flight state.
    return new Promise<EngineResult>((resolve) => {
      resolvers.push((r) => {
        fake.setStats(options.runId, {
          status: r.status,
          agentsSpawned: r.agentsSpawned,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          result: r.status === "completed" ? r.result : null,
          error:
            r.status === "completed"
              ? null
              : `Workflow ended with status ${r.status}`,
          finishedAt: Date.now(),
        });
        resolve(r);
      });
    }) as ReturnType<WorkflowRunManagerDeps["executeWorkflow"]>;
  };

  const deps: Partial<WorkflowRunManagerDeps> = {
    executeWorkflow: opts?.engine ?? defaultEngine,
    leafRunner: (() => {
      throw new Error("leafRunner must not be called in run-manager tests");
    }) as unknown as WorkflowRunManagerDeps["leafRunner"],
    journal: fake.journal,
    getConfig: () => makeConfig(opts?.maxConcurrentRuns),
    isFlagEnabled: () => opts?.flagEnabled ?? true,
    wake: (async (wakeOpts) => {
      wakes.push({
        conversationId: wakeOpts.conversationId,
        hint: wakeOpts.hint,
        source: wakeOpts.source,
      });
      return { invoked: true, producedToolCalls: false };
    }) as WorkflowRunManagerDeps["wake"],
    broadcast: ((msg) => {
      broadcasts.push(msg as { type: string });
    }) as WorkflowRunManagerDeps["broadcast"],
    newRunId: (() => {
      let n = 0;
      return () => `run-${++n}`;
    })(),
    ...(opts?.getWorkflow ? { getWorkflow: opts.getWorkflow } : {}),
  };

  const manager = new WorkflowRunManager(deps);

  return {
    manager,
    executeCalls,
    broadcasts,
    wakes,
    fake,
    resolveLatest: async (result) => {
      const resolve = resolvers[resolvers.length - 1];
      if (!resolve) throw new Error("no in-flight engine run to resolve");
      resolve(result);
      // Let the manager's post-completion microtasks (broadcast + wake) settle.
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe("WorkflowRunManager.start — flag gate", () => {
  test("flag off → start throws and the engine is never invoked", () => {
    const h = makeHarness({ flagEnabled: false });
    expect(() =>
      h.manager.start({
        scriptSource: "export const meta = { name: 'x', description: 'y' }",
        args: {},
        manifest: { tools: [], hostFunctions: [], persona: false },
        trustContext: TRUST,
      }),
    ).toThrow(WorkflowsDisabledError);
    expect(h.executeCalls).toHaveLength(0);
    expect(h.fake.rows.size).toBe(0);
  });
});

describe("WorkflowRunManager.start — concurrent-run cap", () => {
  test("the (N+1)th concurrent start is rejected", () => {
    const h = makeHarness({ maxConcurrentRuns: 2 });
    const startOne = () =>
      h.manager.start({
        scriptSource: "export const meta = { name: 'x', description: 'y' }",
        args: {},
        manifest: { tools: [], hostFunctions: [], persona: false },
        trustContext: TRUST,
      });

    startOne();
    startOne();
    expect(h.manager.inflightCount()).toBe(2);
    expect(() => startOne()).toThrow(WorkflowRunCapError);
    // The rejected start created no extra run row.
    expect(h.fake.rows.size).toBe(2);
  });

  test("a finished run frees a cap slot", async () => {
    const h = makeHarness({ maxConcurrentRuns: 1 });
    const start = () =>
      h.manager.start({
        scriptSource: "export const meta = { name: 'x', description: 'y' }",
        args: {},
        manifest: { tools: [], hostFunctions: [], persona: false },
        trustContext: TRUST,
      });

    start();
    expect(() => start()).toThrow(WorkflowRunCapError);

    await h.resolveLatest({
      status: "completed",
      result: "ok",
      agentsSpawned: 1,
      inputTokens: 10,
      outputTokens: 5,
    });

    expect(h.manager.inflightCount()).toBe(0);
    // Slot freed: a second run now starts without throwing.
    expect(() => start()).not.toThrow();
  });
});

describe("WorkflowRunManager.abort", () => {
  test("abort signals the engine's AbortController", () => {
    const h = makeHarness();
    const { runId } = h.manager.start({
      scriptSource: "export const meta = { name: 'x', description: 'y' }",
      args: {},
      manifest: { tools: [], hostFunctions: [], persona: false },
      trustContext: TRUST,
    });

    const passedSignal = h.executeCalls[0]!.signal!;
    expect(passedSignal.aborted).toBe(false);
    h.manager.abort(runId);
    expect(passedSignal.aborted).toBe(true);
  });

  test("an aborted run resolves with status 'aborted' and persists it", async () => {
    const h = makeHarness();
    const { runId } = h.manager.start({
      scriptSource: "export const meta = { name: 'x', description: 'y' }",
      args: {},
      manifest: { tools: [], hostFunctions: [], persona: false },
      trustContext: TRUST,
    });

    h.manager.abort(runId);
    // The (faked) engine observes the abort and reports the terminal status.
    await h.resolveLatest({
      status: "aborted",
      result: null,
      agentsSpawned: 2,
      inputTokens: 0,
      outputTokens: 0,
    });

    expect(h.manager.status(runId)?.status).toBe("aborted");
    const completed = h.broadcasts.find((b) => b.type === "workflow_completed");
    expect(completed?.status).toBe("aborted");
  });
});

describe("WorkflowRunManager — progress events", () => {
  test("onProgress phase/log are republished as workflow_progress", async () => {
    const h = makeHarness();
    h.manager.start({
      scriptSource: "export const meta = { name: 'x', description: 'y' }",
      args: {},
      manifest: { tools: [], hostFunctions: [], persona: false },
      label: "My Flow",
      trustContext: TRUST,
    });

    const onProgress = h.executeCalls[0]!.onProgress!;
    onProgress({ type: "phase", title: "Gathering" });
    onProgress({ type: "log", message: "step done" });

    const progress = h.broadcasts.filter((b) => b.type === "workflow_progress");
    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatchObject({
      type: "workflow_progress",
      label: "My Flow",
      phase: "Gathering",
    });
    expect(progress[1]).toMatchObject({
      type: "workflow_progress",
      message: "step done",
    });
  });
});

describe("WorkflowRunManager — completion", () => {
  test("completion publishes workflow_completed and injects into the conversation", async () => {
    const h = makeHarness();
    const { runId } = h.manager.start({
      scriptSource: "export const meta = { name: 'x', description: 'y' }",
      args: {},
      manifest: { tools: [], hostFunctions: [], persona: false },
      conversationId: "conv-1",
      label: "Digest",
      trustContext: TRUST,
    });

    await h.resolveLatest({
      status: "completed",
      result: { summary: "all good" },
      agentsSpawned: 4,
      inputTokens: 100,
      outputTokens: 50,
    });

    const completed = h.broadcasts.find((b) => b.type === "workflow_completed");
    expect(completed).toMatchObject({
      type: "workflow_completed",
      runId,
      status: "completed",
      agentsSpawned: 4,
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(typeof completed?.summary).toBe("string");

    // Completion summary surfaced to the originating conversation via a wake.
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]).toMatchObject({
      conversationId: "conv-1",
      source: "workflow_completed",
    });
    expect(h.wakes[0]!.hint).toContain("completed");

    // Final stats persisted to the run row.
    const run = h.manager.status(runId);
    expect(run?.status).toBe("completed");
    expect(run?.agentsSpawned).toBe(4);
    expect(run?.inputTokens).toBe(100);
    expect(run?.outputTokens).toBe(50);
  });

  test("no conversationId → completion events fire but no wake", async () => {
    const h = makeHarness();
    h.manager.start({
      scriptSource: "export const meta = { name: 'x', description: 'y' }",
      args: {},
      manifest: { tools: [], hostFunctions: [], persona: false },
      trustContext: TRUST,
    });

    await h.resolveLatest({
      status: "completed",
      result: "x",
      agentsSpawned: 1,
      inputTokens: 1,
      outputTokens: 1,
    });

    expect(h.broadcasts.some((b) => b.type === "workflow_completed")).toBe(
      true,
    );
    expect(h.wakes).toHaveLength(0);
  });
});

describe("WorkflowRunManager.start — saved-workflow name resolution", () => {
  const SAVED_SOURCE =
    "export const meta = { name: 'saved-flow', description: 'd' }";

  test("start({ name }) resolves the library source and runs it", () => {
    const h = makeHarness({
      getWorkflow: (name) =>
        name === "saved-flow"
          ? { source: SAVED_SOURCE, path: "/ws/workflows/saved.workflow.ts" }
          : null,
    });

    const { runId } = h.manager.start({
      name: "saved-flow",
      args: { x: 1 },
      manifest: { tools: [], hostFunctions: [], persona: false },
      trustContext: TRUST,
    });

    // The run row + engine call carry the RESOLVED source, not the name.
    expect(h.fake.rows.get(runId)?.scriptSource).toBe(SAVED_SOURCE);
    expect(h.executeCalls).toHaveLength(1);
    expect(h.executeCalls[0]!.scriptSource).toBe(SAVED_SOURCE);
    // meta.name is extracted from the resolved source.
    expect(h.fake.rows.get(runId)?.name).toBe("saved-flow");
  });

  test("start({ name }) with an unknown name throws and creates no run row", () => {
    const h = makeHarness({ getWorkflow: () => null });
    expect(() =>
      h.manager.start({
        name: "ghost",
        args: {},
        manifest: { tools: [], hostFunctions: [], persona: false },
        trustContext: TRUST,
      }),
    ).toThrow(WorkflowNotFoundError);
    expect(h.executeCalls).toHaveLength(0);
    expect(h.fake.rows.size).toBe(0);
  });
});
