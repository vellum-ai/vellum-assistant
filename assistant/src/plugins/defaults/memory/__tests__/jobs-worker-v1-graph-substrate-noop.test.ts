/**
 * V1 graph rows (`graph_bootstrap`, `graph_decay`, `graph_consolidate`,
 * `graph_pattern_scan`, `graph_narrative_refine`, `graph_extract`) must
 * complete as no-ops whenever v1 is not the live memory tier: their handlers
 * mutate the legacy v1 graph — the bootstrap and the extraction run LLM work
 * into it — which only the v1 tier reads, so a stale or hand-enqueued row must
 * not consume LLM budget or write the dormant store. On a v1 config the same
 * handlers run their real implementations.
 *
 * "Not the live tier" is one condition, `isMemoryV1Active`, and it covers TWO
 * states: concept-page memory active, and memory switched off entirely. Both
 * are asserted per handler here — the guard used to be spelled three different
 * ways that agreed on the substrate case and disagreed on memory-off.
 *
 * `memory.enabled` and `memory.v2.enabled` both default true, so the real
 * loader reading this file's (empty) workspace config already yields the
 * substrate-active state the worker-level tests need. The handler-level
 * tests pass explicit configs instead.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { eq } from "drizzle-orm";

import { assertNotLiveDb } from "../../../../__tests__/assert-not-live-db.js";
import type { AssistantConfig } from "../../../../config/types.js";
import type { MemoryJob } from "../../../../persistence/jobs-store.js";

let bootstrapCalls = 0;
let decayCalls = 0;
let consolidateCalls = 0;
let patternScanCalls = 0;
let narrativeCalls = 0;
let extractCalls = 0;

mock.module("../v1/graph/bootstrap.js", () => ({
  bootstrapFromHistory: async () => {
    bootstrapCalls += 1;
    return {
      conversationsProcessed: 0,
      conversationsSkipped: 0,
      totalNodesCreated: 0,
      totalNodesUpdated: 0,
      totalNodesReinforced: 0,
      totalEdgesCreated: 0,
      totalTriggersCreated: 0,
      errors: [],
      elapsedMs: 0,
    };
  },
  bootstrapFromJournal: async () => ({ extracted: 0, errors: 0 }),
  maybeEnqueueGraphBootstrap: () => {},
  resetBootstrapCheckpoint: () => {},
  migrateToolCreatedItems: () => {},
  cleanupStaleItemVectors: async () => {},
}));

mock.module("../v1/graph/decay.js", () => ({
  runDecayTick: () => {
    decayCalls += 1;
    return { nodesProcessed: 0, fidelityTransitions: 0, nodesGone: 0 };
  },
}));

mock.module("../v1/graph/consolidation.js", () => ({
  runConsolidation: async () => {
    consolidateCalls += 1;
    return { totalUpdated: 0, totalDeleted: 0, totalMergeEdges: 0 };
  },
}));

mock.module("../v1/graph/pattern-scan.js", () => ({
  runPatternScan: async () => {
    patternScanCalls += 1;
    return { patternsDetected: 0, edgesCreated: 0 };
  },
}));

mock.module("../v1/graph/narrative.js", () => ({
  runNarrativeRefinement: async () => {
    narrativeCalls += 1;
    return { nodesUpdated: 0, arcsIdentified: 0 };
  },
}));

mock.module("../v1/graph/extraction-job.js", () => ({
  graphExtractJob: async () => {
    extractCalls += 1;
  },
}));

mock.module("../../../../persistence/db-maintenance.js", () => ({
  maybeRunDbMaintenance: () => {},
  maybeRunPassiveWalCheckpoint: () => {},
}));

const tmpWorkspace = mkdtempSync(
  join(tmpdir(), "jobs-worker-v1-graph-substrate-noop-"),
);
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

const { setConfig } =
  await import("../../../../__tests__/helpers/set-config.js");

// Generous lane caps so a single `runMemoryJobsOnce` tick claims every seeded
// row (the default slow-LLM cap is 1). `memory.v2.enabled` keeps its default
// (true), so concept-page memory is active.
setConfig("memory", {
  jobs: { slowLlmConcurrency: 8, fastConcurrency: 8 },
});

const { applyNestedDefaults } = await import("../../../../config/loader.js");
const { getMemoryDb } =
  await import("../../../../persistence/db-connection.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");
const { _resetQdrantBreaker } =
  await import("../../../../persistence/embeddings/qdrant-circuit-breaker.js");
const { enqueueMemoryJob } =
  await import("../../../../persistence/jobs-store.js");
const { memoryJobs } = await import("../../../../persistence/schema/index.js");
const { memoryJobHandlers } = await import("../job-handlers.js");
const { registerMemoryPluginJobHandlers } =
  await import("../job-handler-registration.js");
const { runMemoryJobsOnce } = await import("../jobs-worker.js");

function resetCallCounts(): void {
  bootstrapCalls = 0;
  decayCalls = 0;
  consolidateCalls = 0;
  patternScanCalls = 0;
  narrativeCalls = 0;
  extractCalls = 0;
}

function jobStatus(jobId: string): string | undefined {
  return getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.id, jobId))
    .all()[0]?.status;
}

function handlerFor(type: string) {
  const entry = memoryJobHandlers.find((candidate) => candidate.type === type);
  if (!entry) {
    throw new Error(`No handler registered for job type: ${type}`);
  }
  return entry.handler;
}

function fakeJob(type: string): MemoryJob {
  return {
    id: `job-${type}`,
    type,
    payload: {},
    status: "running",
    attempts: 0,
    deferrals: 0,
    runAfter: 0,
    lastError: null,
    startedAt: null,
    createdAt: 0,
    updatedAt: 0,
  } as MemoryJob;
}

function v1Config(): AssistantConfig {
  const config = applyNestedDefaults({});
  config.memory.v2.enabled = false;
  return config;
}

function memoryDisabledConfig(): AssistantConfig {
  const config = applyNestedDefaults({});
  config.memory.enabled = false;
  return config;
}

function v3LiveConfig(): AssistantConfig {
  const config = applyNestedDefaults({});
  config.memory.v3.live = true;
  return config;
}

describe("v1 graph jobs under concept-page memory", () => {
  beforeAll(async () => {
    registerMemoryPluginJobHandlers();
    await initializeDb();
  }, 30_000);

  afterAll(() => {
    if (previousWorkspaceEnv === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
    }
    assertNotLiveDb(tmpWorkspace);
    rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    getMemoryDb()!.run("DELETE FROM memory_jobs");
    resetCallCounts();
    _resetQdrantBreaker();
  });

  test("a graph_bootstrap row completes as a no-op without running the bootstrap", async () => {
    const jobId = enqueueMemoryJob("graph_bootstrap", {});

    await runMemoryJobsOnce();

    expect(bootstrapCalls).toBe(0);
    expect(jobStatus(jobId)).toBe("completed");
  });

  test("v1 maintenance rows complete as no-ops without running their implementations", async () => {
    const jobIds = {
      decay: enqueueMemoryJob("graph_decay", {}),
      consolidate: enqueueMemoryJob("graph_consolidate", {}),
      patternScan: enqueueMemoryJob("graph_pattern_scan", {}),
      narrative: enqueueMemoryJob("graph_narrative_refine", {}),
    };

    await runMemoryJobsOnce();

    expect(decayCalls).toBe(0);
    expect(consolidateCalls).toBe(0);
    expect(patternScanCalls).toBe(0);
    expect(narrativeCalls).toBe(0);
    expect(jobStatus(jobIds.decay)).toBe("completed");
    expect(jobStatus(jobIds.consolidate)).toBe("completed");
    expect(jobStatus(jobIds.patternScan)).toBe("completed");
    expect(jobStatus(jobIds.narrative)).toBe("completed");
  });

  test("the graph_bootstrap handler no-ops on a v3-live config", async () => {
    await handlerFor("graph_bootstrap")(
      fakeJob("graph_bootstrap"),
      v3LiveConfig(),
    );

    expect(bootstrapCalls).toBe(0);
  });

  test("the graph_bootstrap handler runs the bootstrap on a v1 config", async () => {
    await handlerFor("graph_bootstrap")(fakeJob("graph_bootstrap"), v1Config());

    expect(bootstrapCalls).toBe(1);
  });

  test("the graph_decay handler no-ops on a v3-live config", async () => {
    await handlerFor("graph_decay")(fakeJob("graph_decay"), v3LiveConfig());

    expect(decayCalls).toBe(0);
  });

  test("the graph_decay handler runs the decay tick on a v1 config", async () => {
    await handlerFor("graph_decay")(fakeJob("graph_decay"), v1Config());

    expect(decayCalls).toBe(1);
  });

  // ── The unified guard: memory-off behaves exactly like the substrate ──

  test("every v1 graph handler no-ops on a memory-disabled config", async () => {
    const config = memoryDisabledConfig();

    await handlerFor("graph_bootstrap")(fakeJob("graph_bootstrap"), config);
    await handlerFor("graph_decay")(fakeJob("graph_decay"), config);
    await handlerFor("graph_consolidate")(fakeJob("graph_consolidate"), config);
    await handlerFor("graph_pattern_scan")(
      fakeJob("graph_pattern_scan"),
      config,
    );
    await handlerFor("graph_narrative_refine")(
      fakeJob("graph_narrative_refine"),
      config,
    );
    await handlerFor("graph_extract")(fakeJob("graph_extract"), config);

    expect(bootstrapCalls).toBe(0);
    expect(decayCalls).toBe(0);
    expect(consolidateCalls).toBe(0);
    expect(patternScanCalls).toBe(0);
    expect(narrativeCalls).toBe(0);
    expect(extractCalls).toBe(0);
  });

  test("the graph_extract handler no-ops off v1 and runs on v1", async () => {
    // `graph_extract` re-inlined its own substrate check instead of sharing the
    // lifecycle handlers' guard; it now answers to the same condition, so it
    // must skip on BOTH off-v1 states and still run on v1.
    await handlerFor("graph_extract")(fakeJob("graph_extract"), v3LiveConfig());
    expect(extractCalls).toBe(0);

    await handlerFor("graph_extract")(
      fakeJob("graph_extract"),
      memoryDisabledConfig(),
    );
    expect(extractCalls).toBe(0);

    await handlerFor("graph_extract")(fakeJob("graph_extract"), v1Config());
    expect(extractCalls).toBe(1);
  });

  test("memory-off leaves v1 Qdrant rows unclaimed, matching the dispatch guard", async () => {
    // The dispatch-level half of the guard (`V1_QDRANT_JOB_TYPES` in
    // `processJob`) reads the same predicate as the handlers, so a v1 embed row
    // is dead work while memory is off. `runMemoryJobsOnce` never even claims
    // it in that state — only the message-lexical types are claimable — so the
    // row stays pending for a later return to v1 rather than being drained.
    const jobId = enqueueMemoryJob("embed_segment", {});
    setConfig("memory", {
      enabled: false,
      jobs: { slowLlmConcurrency: 8, fastConcurrency: 8 },
    });
    try {
      await runMemoryJobsOnce();
      expect(jobStatus(jobId)).toBe("pending");
    } finally {
      setConfig("memory", {
        jobs: { slowLlmConcurrency: 8, fastConcurrency: 8 },
      });
    }

    // Back on the substrate the same row IS claimed, and the dispatch guard
    // completes it as a no-op (the v1 Qdrant client is not initialized).
    await runMemoryJobsOnce();
    expect(jobStatus(jobId)).toBe("completed");
  });
});
