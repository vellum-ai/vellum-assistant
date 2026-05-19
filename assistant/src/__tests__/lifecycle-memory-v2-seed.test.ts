/**
 * Tests for the memory-v2 skill seed gate and the v2 concept-page schema
 * rebuild gate, both invoked from the daemon startup path
 * (`assistant/src/daemon/memory-v2-startup.ts`).
 *
 * The gates are exercised in isolation rather than mounting the full
 * lifecycle import graph. Coverage matrix:
 *   - Skill seed (`maybeSeedMemoryV2Skills`): config gating, rejection
 *     swallowing.
 *   - Schema rebuild (`maybeRebuildMemoryV2Concepts`): config gating,
 *     drift-triggered reembed enqueue, empty-after-create reembed enqueue,
 *     no enqueue when collection is healthy, error swallowing.
 *
 * Both gates must never block startup or surface an exception.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Programmable test state — drives every mocked dependency below.
// ---------------------------------------------------------------------------

interface TestState {
  seedCallCount: number;
  seedCallOpts: Array<{ throwOnError?: boolean } | undefined>;
  seedShouldReject: Error | null;
  warnCalls: Array<{ obj: unknown; msg: unknown }>;
  infoCalls: Array<{ obj: unknown; msg: unknown }>;
  // Rebuild-gate mocks (drive maybeRebuildMemoryV2Concepts).
  ensureCollectionCallCount: number;
  ensureCollectionResult: { migrated: boolean };
  ensureCollectionThrows: Error | null;
  countResult: number;
  listPagesResult: string[];
  enqueueCalls: Array<{ type: string; payload: Record<string, unknown> }>;
  clearSentinelCallCount: number;
  // BM25 corpus-stats rebuild + reseed mocks.
  corpusStatsBuildCount: number;
  corpusStatsThrows: Error | null;
}

const state: TestState = {
  seedCallCount: 0,
  seedCallOpts: [],
  seedShouldReject: null,
  warnCalls: [],
  infoCalls: [],
  ensureCollectionCallCount: 0,
  ensureCollectionResult: { migrated: false },
  ensureCollectionThrows: null,
  countResult: 0,
  listPagesResult: [],
  enqueueCalls: [],
  clearSentinelCallCount: 0,
  corpusStatsBuildCount: 0,
  corpusStatsThrows: null,
};

// ---------------------------------------------------------------------------
// Mocks — installed before the module under test is loaded.
// ---------------------------------------------------------------------------

mock.module("../memory/v2/skill-store.js", () => ({
  seedV2SkillEntries: async (opts?: {
    throwOnError?: boolean;
  }): Promise<void> => {
    state.seedCallCount += 1;
    state.seedCallOpts.push(opts);
    if (state.seedShouldReject) throw state.seedShouldReject;
  },
}));

// Mock the sibling CLI-command seeder so `rebuildBm25CorpusStatsAndReseedSkills`
// (which runs both reseeds in parallel) does not invoke the real Qdrant-backed
// implementation and emit warnings that break the no-warnings assertions below.
mock.module("../memory/v2/cli-command-store.js", () => ({
  seedV2CliCommandEntries: async (): Promise<void> => {},
}));

mock.module("../memory/v2/qdrant.js", () => ({
  ensureConceptPageCollection: async (): Promise<{ migrated: boolean }> => {
    state.ensureCollectionCallCount += 1;
    if (state.ensureCollectionThrows) throw state.ensureCollectionThrows;
    return state.ensureCollectionResult;
  },
  countConceptPagePoints: async (): Promise<number> => state.countResult,
  clearReembedSentinel: async (): Promise<void> => {
    state.clearSentinelCallCount += 1;
  },
  // The rebuild gate does not call this, but the seed gate's fire-and-forget
  // chain imports it; provide a no-op so the dynamic import resolves.
  dropLegacySkillsCollection: async (): Promise<void> => {},
}));

mock.module("../memory/v2/page-store.js", () => ({
  hasConceptPages: async (): Promise<boolean> =>
    state.listPagesResult.length > 0,
}));

mock.module("../memory/v2/sparse-bm25.js", () => ({
  rebuildConceptPageCorpusStats: async (): Promise<void> => {
    state.corpusStatsBuildCount += 1;
    if (state.corpusStatsThrows) throw state.corpusStatsThrows;
  },
}));

mock.module("../memory/jobs-store.js", () => ({
  enqueueMemoryJob: (
    type: string,
    payload: Record<string, unknown>,
  ): string => {
    state.enqueueCalls.push({ type, payload });
    return "test-job-id";
  },
}));

mock.module("../util/platform.js", () => ({
  getWorkspaceDir: () => "/tmp/test-workspace",
  // qdrant.ts (mocked away in this file) reads `getDataDir` for the reembed
  // sentinel path; bun mocks share the same module record across files, so
  // include it here too so a peer test importing `getDataDir` doesn't see
  // `undefined` after this mock evaluates.
  getDataDir: () => "/tmp/test-workspace/data",
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    warn: (obj: unknown, msg: unknown) => {
      state.warnCalls.push({ obj, msg });
    },
    info: (obj: unknown, msg: unknown) => {
      state.infoCalls.push({ obj, msg });
    },
    error: () => {},
    debug: () => {},
  }),
}));

const {
  maybeSeedMemoryV2Skills,
  maybeRebuildMemoryV2Concepts,
  rebuildBm25CorpusStatsAndReseedSkills,
} = await import("../daemon/memory-v2-startup.js");

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Minimal config shape the gate touches; cast to AssistantConfig at the boundary. */
function makeConfig(v2Enabled: boolean): AssistantConfig {
  return {
    memory: {
      v2: { enabled: v2Enabled },
    },
  } as unknown as AssistantConfig;
}

/**
 * Drain all microtasks so any `void`-prefixed promise inside
 * `maybeSeedMemoryV2Skills` settles before the test asserts. The fire-and-
 * forget chain involves: dynamic-import settle → `.then` callback →
 * inner `seedV2SkillEntries` resolution → `.catch` settle. We yield
 * generously to cover that whole chain regardless of the bundler's task
 * scheduling.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function resetState(): void {
  state.seedCallCount = 0;
  state.seedCallOpts = [];
  state.seedShouldReject = null;
  state.warnCalls = [];
  state.infoCalls = [];
  state.ensureCollectionCallCount = 0;
  state.ensureCollectionResult = { migrated: false };
  state.ensureCollectionThrows = null;
  state.countResult = 0;
  state.listPagesResult = [];
  state.enqueueCalls = [];
  state.clearSentinelCallCount = 0;
  state.corpusStatsBuildCount = 0;
  state.corpusStatsThrows = null;
}

describe("maybeSeedMemoryV2Skills (daemon startup gate)", () => {
  beforeEach(resetState);

  test("invokes seedV2SkillEntries when memory.v2.enabled is true", async () => {
    maybeSeedMemoryV2Skills(makeConfig(true));
    await flushMicrotasks();
    expect(state.seedCallCount).toBe(1);
    expect(state.warnCalls).toHaveLength(0);
  });

  test("does not invoke seedV2SkillEntries when memory.v2.enabled is false", async () => {
    maybeSeedMemoryV2Skills(makeConfig(false));
    await flushMicrotasks();
    expect(state.seedCallCount).toBe(0);
    expect(state.warnCalls).toHaveLength(0);
  });

  test("swallows seedV2SkillEntries rejections and logs a warning", async () => {
    state.seedShouldReject = new Error("seed failed");

    // The gate must not throw — startup must not block on this.
    expect(() => maybeSeedMemoryV2Skills(makeConfig(true))).not.toThrow();

    await flushMicrotasks();

    expect(state.seedCallCount).toBe(1);
    expect(state.warnCalls).toHaveLength(1);
    const [{ obj, msg }] = state.warnCalls;
    expect((obj as { err: Error }).err.message).toBe("seed failed");
    expect(msg).toBe("Failed to seed v2 skill entries");
  });
});

describe("maybeRebuildMemoryV2Concepts (daemon startup gate)", () => {
  beforeEach(resetState);

  test("does nothing when memory.v2.enabled is false", async () => {
    await maybeRebuildMemoryV2Concepts(makeConfig(false));

    expect(state.ensureCollectionCallCount).toBe(0);
    expect(state.enqueueCalls).toEqual([]);
  });

  test("enqueues memory_v2_reembed when the collection was migrated", async () => {
    state.ensureCollectionResult = { migrated: true };

    await maybeRebuildMemoryV2Concepts(makeConfig(true));

    expect(state.ensureCollectionCallCount).toBe(1);
    expect(state.enqueueCalls).toEqual([
      { type: "memory_v2_reembed", payload: {} },
    ]);
    // After the reembed is queued, the on-disk sentinel that the qdrant
    // ensure-path may have written is cleared so it does not re-trigger on
    // the next startup.
    expect(state.clearSentinelCallCount).toBe(1);
    // Migrated path skips the count probe — drift detection is the trigger.
    // (The mock's countConceptPagePoints would silently return 0 either way,
    // but keeping the path conditional keeps the lifecycle hook predictable.)
  });

  test("enqueues reembed when the collection is empty but pages exist on disk (crash-mid-rebuild recovery)", async () => {
    state.ensureCollectionResult = { migrated: false };
    state.countResult = 0;
    state.listPagesResult = ["people/alice", "topics/zsh"];

    await maybeRebuildMemoryV2Concepts(makeConfig(true));

    expect(state.enqueueCalls).toEqual([
      { type: "memory_v2_reembed", payload: {} },
    ]);
  });

  test("does not enqueue when the collection is healthy and populated", async () => {
    state.ensureCollectionResult = { migrated: false };
    state.countResult = 1185;
    state.listPagesResult = ["people/alice"];

    await maybeRebuildMemoryV2Concepts(makeConfig(true));

    expect(state.enqueueCalls).toEqual([]);
  });

  test("does not enqueue when the collection is empty AND no pages exist on disk (fresh workspace)", async () => {
    state.ensureCollectionResult = { migrated: false };
    state.countResult = 0;
    state.listPagesResult = [];

    await maybeRebuildMemoryV2Concepts(makeConfig(true));

    expect(state.enqueueCalls).toEqual([]);
  });

  test("swallows ensureConceptPageCollection failures and logs a warning", async () => {
    state.ensureCollectionThrows = new Error("Qdrant unreachable");

    // Must not throw — startup never blocks on this gate.
    let thrown: unknown = null;
    try {
      await maybeRebuildMemoryV2Concepts(makeConfig(true));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeNull();

    expect(state.enqueueCalls).toEqual([]);
    expect(state.warnCalls.length).toBeGreaterThan(0);
    const lastWarn = state.warnCalls[state.warnCalls.length - 1];
    expect((lastWarn.obj as { err: Error }).err.message).toBe(
      "Qdrant unreachable",
    );
  });
});

describe("rebuildBm25CorpusStatsAndReseedSkills", () => {
  beforeEach(resetState);

  test("builds corpus stats then re-seeds skills when v2 is enabled", async () => {
    await rebuildBm25CorpusStatsAndReseedSkills(makeConfig(true));

    expect(state.corpusStatsBuildCount).toBe(1);
    expect(state.seedCallCount).toBe(1);
    // Must pass throwOnError: true so a swallowed internal seed failure
    // cannot trip the unconditional success log in the caller.
    expect(state.seedCallOpts[0]).toEqual({ throwOnError: true });
    expect(state.warnCalls).toHaveLength(0);
  });

  test("skips both corpus stats and skill reseed when v2 is disabled", async () => {
    await rebuildBm25CorpusStatsAndReseedSkills(makeConfig(false));

    expect(state.corpusStatsBuildCount).toBe(0);
    expect(state.seedCallCount).toBe(0);
    expect(state.warnCalls).toHaveLength(0);
  });

  test("skips the reseed and logs a warning when the corpus-stats build throws", async () => {
    state.corpusStatsThrows = new Error("listPages failed");

    // Must not throw — fire-and-forget startup must not block.
    let thrown: unknown = null;
    try {
      await rebuildBm25CorpusStatsAndReseedSkills(makeConfig(true));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeNull();

    expect(state.corpusStatsBuildCount).toBe(1);
    expect(state.seedCallCount).toBe(0);
    const corpusWarn = state.warnCalls.find(
      (w) =>
        typeof w.msg === "string" &&
        w.msg.includes("BM25 corpus-stats rebuild failed"),
    );
    expect(corpusWarn).toBeTruthy();
  });

  test("swallows skill-reseed rejections after a successful corpus-stats build", async () => {
    state.seedShouldReject = new Error("reseed failed");

    let thrown: unknown = null;
    try {
      await rebuildBm25CorpusStatsAndReseedSkills(makeConfig(true));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeNull();

    expect(state.corpusStatsBuildCount).toBe(1);
    expect(state.seedCallCount).toBe(1);
    const reseedWarn = state.warnCalls.find(
      (w) =>
        typeof w.msg === "string" &&
        w.msg.includes("Failed to re-seed v2 skill entries"),
    );
    expect(reseedWarn).toBeTruthy();
  });
});
