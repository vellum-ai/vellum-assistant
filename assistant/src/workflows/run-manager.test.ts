import { describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { AssistantConfig } from "../config/schema.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import type { ExecuteWorkflowOptions } from "./engine.js";
import { WorkflowNotFoundError } from "./engine.js";
import type {
  CreateRunInput,
  WorkflowRun,
  WorkflowRunStatus,
} from "./journal-store.js";
import {
  WorkflowResumeNotPossibleError,
  WorkflowRunCapError,
  WorkflowRunManager,
  type WorkflowRunManagerDeps,
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
          trust: input.trust ?? null,
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
      updateRun: (
        id: string,
        patch: Partial<WorkflowRun>,
      ): WorkflowRun | null => {
        const existing = rows.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...patch, updatedAt: Date.now() };
        rows.set(id, updated);
        return updated;
      },
      markRunningAsInterrupted: (): number => {
        let n = 0;
        for (const [id, run] of rows) {
          if (run.status === "running") {
            rows.set(id, { ...run, status: "interrupted" });
            n += 1;
          }
        }
        return n;
      },
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
      conversationId: "conv-1",
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
      conversationId: "conv-1",
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
      conversationId: "conv-1",
      label: "My Flow",
      phase: "Gathering",
    });
    expect(progress[1]).toMatchObject({
      type: "workflow_progress",
      conversationId: "conv-1",
      message: "step done",
    });
  });

  test("a run with no conversation broadcasts progress unscoped (no conversationId)", () => {
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

    // `workflow_progress` is a pre-existing event; it still broadcasts for a
    // conversationless run, just without a `conversationId` (unscoped).
    const progress = h.broadcasts.filter((b) => b.type === "workflow_progress");
    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatchObject({
      type: "workflow_progress",
      label: "My Flow",
      phase: "Gathering",
    });
    expect(progress[0]).not.toHaveProperty("conversationId");
  });

  test("onLeaf start/finish are republished as scoped leaf events", () => {
    const fakeEngine: WorkflowRunManagerDeps["executeWorkflow"] = (options) => {
      options.onLeaf?.({
        type: "leaf_started",
        seq: 1,
        label: "Research",
        phase: "Gather",
        promptSummary: "look it up",
      });
      options.onLeaf?.({
        type: "leaf_finished",
        seq: 1,
        status: "completed",
        label: "Research",
        inputTokens: 30,
        outputTokens: 12,
        resultSummary: "found it",
      });
      return new Promise(() => {}) as ReturnType<
        WorkflowRunManagerDeps["executeWorkflow"]
      >;
    };
    const h = makeHarness({ engine: fakeEngine });

    const { runId } = h.manager.start({
      scriptSource: "export const meta = { name: 'x', description: 'y' }",
      args: {},
      manifest: { tools: [], hostFunctions: [], persona: false },
      conversationId: "conv-1",
      trustContext: TRUST,
    });

    const started = h.broadcasts.find(
      (b) => b.type === "workflow_leaf_started",
    );
    expect(started).toMatchObject({
      type: "workflow_leaf_started",
      runId,
      conversationId: "conv-1",
      seq: 1,
      label: "Research",
      phase: "Gather",
      promptSummary: "look it up",
    });

    const finished = h.broadcasts.find(
      (b) => b.type === "workflow_leaf_finished",
    );
    expect(finished).toMatchObject({
      type: "workflow_leaf_finished",
      runId,
      conversationId: "conv-1",
      seq: 1,
      status: "completed",
      label: "Research",
      inputTokens: 30,
      outputTokens: 12,
      resultSummary: "found it",
    });
  });

  test("a run with no conversation gets no onLeaf callback", () => {
    const h = makeHarness();
    h.manager.start({
      scriptSource: "export const meta = { name: 'x', description: 'y' }",
      args: {},
      manifest: { tools: [], hostFunctions: [], persona: false },
      trustContext: TRUST,
    });

    expect(h.executeCalls[0]!.onLeaf).toBeUndefined();
  });
});

describe("WorkflowRunManager.start — workflow_started", () => {
  test("start with a conversation broadcasts workflow_started carrying toolUseId", () => {
    const h = makeHarness();
    const { runId } = h.manager.start({
      scriptSource: "export const meta = { name: 'x', description: 'y' }",
      args: {},
      manifest: { tools: [], hostFunctions: [], persona: false },
      conversationId: "conv-1",
      toolUseId: "toolu-abc",
      label: "My Flow",
      trustContext: TRUST,
    });

    const started = h.broadcasts.find((b) => b.type === "workflow_started");
    expect(started).toMatchObject({
      type: "workflow_started",
      runId,
      conversationId: "conv-1",
      toolUseId: "toolu-abc",
      label: "My Flow",
    });
  });

  test("start without a conversation broadcasts no workflow_started", () => {
    const h = makeHarness();
    h.manager.start({
      scriptSource: "export const meta = { name: 'x', description: 'y' }",
      args: {},
      manifest: { tools: [], hostFunctions: [], persona: false },
      trustContext: TRUST,
    });

    expect(h.broadcasts.some((b) => b.type === "workflow_started")).toBe(false);
  });

  test("resume never broadcasts workflow_started", () => {
    const h = makeHarness({});
    seedRun(h, {
      id: "run-x",
      status: "interrupted",
      conversationId: "conv-1",
    });

    h.manager.resume("run-x");

    expect(h.broadcasts.some((b) => b.type === "workflow_started")).toBe(false);
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
      conversationId: "conv-1",
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

  test("a large result is truncated in the summary but kept whole on the run row", async () => {
    const h = makeHarness();
    const big = "x".repeat(50_000);
    const { runId } = h.manager.start({
      scriptSource: "export const meta = { name: 'x', description: 'y' }",
      args: {},
      manifest: { tools: [], hostFunctions: [], persona: false },
      conversationId: "conv-big",
      label: "Digest",
      trustContext: TRUST,
    });

    await h.resolveLatest({
      status: "completed",
      result: big,
      agentsSpawned: 1,
      inputTokens: 1,
      outputTokens: 1,
    });

    const completed = h.broadcasts.find((b) => b.type === "workflow_completed");
    // The summary (event + wake) is bounded well under the raw result size.
    const summary = String(completed?.summary ?? "");
    expect(summary.length).toBeLessThan(big.length);
    expect(summary).toContain("[truncated");
    expect(h.wakes[0]!.hint).toContain("[truncated");

    // The durable run row keeps the FULL, untruncated result.
    expect(h.manager.status(runId)?.result).toBe(big);
  });

  test("no conversationId → pre-existing events broadcast unscoped; UI events and wake are gated", async () => {
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

    // The pre-existing terminal event still broadcasts (unscoped) so raw SSE
    // listeners and conversationless scheduled runs are still surfaced.
    const completed = h.broadcasts.find((b) => b.type === "workflow_completed");
    expect(completed).toMatchObject({
      type: "workflow_completed",
      status: "completed",
    });
    expect(completed).not.toHaveProperty("conversationId");

    // The conversation-only signals stay gated: no `workflow_started`, no leaf
    // events, and no completion wake without an originating conversation.
    expect(h.broadcasts.some((b) => b.type === "workflow_started")).toBe(false);
    expect(h.broadcasts.some((b) => b.type === "workflow_leaf_started")).toBe(
      false,
    );
    expect(h.broadcasts.some((b) => b.type === "workflow_leaf_finished")).toBe(
      false,
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

// Seed a run row directly into the fake journal (bypassing `start`), so resume
// tests can stand up a pre-existing `interrupted`/other-status row.
function seedRun(
  h: ManagerHarness,
  overrides: Partial<WorkflowRun> & { id: string },
): WorkflowRun {
  const run: WorkflowRun = {
    name: "seeded",
    scriptSource: "export const meta = { name: 'seeded', description: 'd' }",
    scriptHash: "hash",
    args: { k: "v" },
    capabilities: { tools: [], hostFunctions: [], persona: false },
    status: "interrupted",
    conversationId: null,
    trust: null,
    agentsSpawned: 3,
    inputTokens: 100,
    outputTokens: 50,
    result: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    ...overrides,
  };
  h.fake.rows.set(run.id, run);
  return run;
}

describe("WorkflowRunManager.reconcileOrphanedRuns", () => {
  test("flips running rows to interrupted, leaving counters untouched", () => {
    const h = makeHarness({});
    seedRun(h, { id: "r-run", status: "running", agentsSpawned: 7 });
    seedRun(h, { id: "r-done", status: "completed", agentsSpawned: 2 });

    const n = h.manager.reconcileOrphanedRuns();

    expect(n).toBe(1);
    const reconciled = h.fake.rows.get("r-run")!;
    expect(reconciled.status).toBe("interrupted");
    // Accounting preserved — reconciliation is status-only.
    expect(reconciled.agentsSpawned).toBe(7);
    expect(reconciled.inputTokens).toBe(100);
    expect(reconciled.outputTokens).toBe(50);
    // A completed run is untouched.
    expect(h.fake.rows.get("r-done")!.status).toBe("completed");
  });
});

describe("WorkflowRunManager.resume", () => {
  test("an interrupted run re-invokes the engine with the SAME runId and carries accounting", async () => {
    const h = makeHarness({});
    seedRun(h, {
      id: "run-x",
      status: "interrupted",
      args: { foo: 1 },
      agentsSpawned: 4,
    });

    const { runId } = h.manager.resume("run-x");
    expect(runId).toBe("run-x");

    // Engine invoked with the same runId + reconstructed args; no NEW row.
    expect(h.executeCalls).toHaveLength(1);
    expect(h.executeCalls[0]!.runId).toBe("run-x");
    expect(h.executeCalls[0]!.args).toEqual({ foo: 1 });

    // Status transitions interrupted → running before launch.
    expect(h.fake.rows.get("run-x")!.status).toBe("running");

    // The engine reports the carried-forward accounting (seed: 4 agents) plus
    // newly spawned work — the count carries, it does NOT reset.
    await h.resolveLatest({
      status: "completed",
      result: "done",
      agentsSpawned: 6,
      inputTokens: 200,
      outputTokens: 90,
    });

    const run = h.manager.status("run-x");
    expect(run?.status).toBe("completed");
    expect(run?.agentsSpawned).toBe(6);
    expect(h.manager.inflightCount()).toBe(0);
  });

  test("resume replays the SAME (non-guardian) trust the run started under — never escalates", () => {
    const h = makeHarness({});
    // A run started by a low-trust actor: persisted trust is NOT guardian.
    const lowTrust: TrustContext = {
      sourceChannel: "slack",
      trustClass: "unknown",
      requesterIdentifier: "@someone",
    };
    seedRun(h, {
      id: "run-x",
      status: "interrupted",
      conversationId: null,
      trust: lowTrust,
    });

    h.manager.resume("run-x");

    const replayed = h.executeCalls[0]!.trustContext;
    // SECURITY: resume must reconstruct the exact trust the run started under,
    // never elevate to guardian (which would clear the side-effect gate).
    expect(replayed.trustClass).toBe("unknown");
    expect(replayed.trustClass).not.toBe("guardian");
    expect(replayed.sourceChannel).toBe("slack");
  });

  test("resume of a trusted_contact run keeps trusted_contact (no escalation)", () => {
    const h = makeHarness({});
    seedRun(h, {
      id: "run-tc",
      status: "interrupted",
      trust: { sourceChannel: "slack", trustClass: "trusted_contact" },
    });

    h.manager.resume("run-tc");

    expect(h.executeCalls[0]!.trustContext.trustClass).toBe("trusted_contact");
  });

  test("SECURITY: a legacy run row with no persisted trust resumes at LOW trust, never guardian", () => {
    const h = makeHarness({});
    // Legacy row: written before the trust_json column existed → trust is null.
    seedRun(h, { id: "run-legacy", status: "interrupted", trust: null });

    h.manager.resume("run-legacy");

    const replayed = h.executeCalls[0]!.trustContext;
    expect(replayed.trustClass).toBe("unknown");
    expect(replayed.trustClass).not.toBe("guardian");
  });

  test("a persisted trust with an unrecognized trustClass falls back to LOW trust", () => {
    const h = makeHarness({});
    seedRun(h, {
      id: "run-bad",
      status: "interrupted",
      // Corrupt/forward-incompatible snapshot: not a known trust class.
      trust: { sourceChannel: "slack", trustClass: "superuser" },
    });

    h.manager.resume("run-bad");

    expect(h.executeCalls[0]!.trustContext.trustClass).toBe("unknown");
  });

  test("start persists the originating trust context on the run row", () => {
    const h = makeHarness({});
    const startTrust: TrustContext = {
      sourceChannel: "slack",
      trustClass: "unknown",
    };
    const { runId } = h.manager.start({
      scriptSource: "export const meta = { name: 'x', description: 'y' }",
      args: {},
      manifest: { tools: [], hostFunctions: [], persona: false },
      trustContext: startTrust,
    });

    expect(h.fake.rows.get(runId)?.trust).toEqual(startTrust);
  });

  test("a non-interrupted run throws WorkflowResumeNotPossibleError and does not invoke the engine", () => {
    const h = makeHarness({});
    seedRun(h, { id: "run-done", status: "completed" });

    expect(() => h.manager.resume("run-done")).toThrow(
      WorkflowResumeNotPossibleError,
    );
    expect(h.executeCalls).toHaveLength(0);
    // The row is untouched (still completed).
    expect(h.fake.rows.get("run-done")!.status).toBe("completed");
  });

  test("an unknown run throws WorkflowResumeNotPossibleError", () => {
    const h = makeHarness({});
    expect(() => h.manager.resume("ghost")).toThrow(
      WorkflowResumeNotPossibleError,
    );
    expect(h.executeCalls).toHaveLength(0);
  });

  test("resume respects the concurrent-run cap", () => {
    const h = makeHarness({ maxConcurrentRuns: 1 });
    // Occupy the single slot with a live run.
    h.manager.start({
      scriptSource: "export const meta = { name: 'x', description: 'y' }",
      args: {},
      manifest: { tools: [], hostFunctions: [], persona: false },
      trustContext: TRUST,
    });
    seedRun(h, { id: "run-x", status: "interrupted" });

    expect(() => h.manager.resume("run-x")).toThrow(WorkflowRunCapError);
  });
});
