// Tests for the memory enqueue gate.
//
// Architecture under test:
//   1. `isMemoryEnabled()` (jobs-store.ts) reads `config.memory.enabled`
//      and returns `true` unless explicitly `false`.
//   2. Each call site that enqueues a memory job gates on this helper
//      before calling `enqueueMemoryJob` / `upsertDebouncedJob` etc.
//      `enqueueMemoryJob` itself is *not* gated — it preserves its
//      "always returns a real job id" contract, and non-memory jobs
//      (`delete_qdrant_vectors`, `prune_*`) flow through unchanged.
//
// We verify (1) directly across the four config-shape variants, then
// smoke-test (2) at two central entry-point helpers:
//   - `enqueueAutoAnalysisIfEnabled`
//   - `enqueueMemoryRetrospectiveIfEnabled`
// Each call site re-checks `isMemoryEnabled()` itself, so we don't
// repeat 30+ identical scenarios — the helper test is the contract.

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mutable config shape, mutated per-test. `null` means "no `memory` key
// at all" — exercises the defensive `?.` chain in `isMemoryEnabled`.
type MemoryEnabledShape = boolean | null | undefined;
let memoryEnabled: MemoryEnabledShape = true;
let getConfigThrows = false;
mock.module("../../config/loader.js", () => ({
  getConfig: () => {
    if (getConfigThrows) throw new Error("config load failed");
    if (memoryEnabled === null) return {};
    return {
      memory: { enabled: memoryEnabled, v2: { enabled: false } },
      analysis: { idleTimeoutMs: 600_000, batchSize: 30 },
      assistant: { featureFlags: { "auto-analyze": true } },
    };
  },
}));

// Stub feature flags so auto-analyze isn't gated by an unrelated flag.
mock.module("../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

// Stub trust resolver — never claim the actor is untrusted in tests.
mock.module("../../runtime/actor-trust-resolver.js", () => ({
  isUntrustedTrustClass: () => false,
}));

// Stub the conversation-source lookup so the recursion guards in the
// retrospective and auto-analysis paths fall through to the enqueue.
mock.module("../conversation-crud.js", () => ({
  getConversationSource: () => null,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));
mock.module("../auto-analysis-guard.js", () => ({
  isAutoAnalysisConversation: () => false,
}));

// Stub the qdrant breaker so `enqueueMemoryJob` doesn't trip on it.
mock.module("../qdrant-circuit-breaker.js", () => ({
  isQdrantBreakerOpen: () => false,
  shouldAllowQdrantProbe: () => true,
}));

// Stub raw query helpers (used by jobs-store internally).
mock.module("../raw-query.js", () => ({
  rawAll: () => [],
  rawChanges: () => 0,
}));

// Drizzle-shaped no-op db. Tracks inserts/updates so tests can observe
// whether an upsert/enqueue actually wrote anything.
const dbInserts: Array<{ table?: unknown; values: unknown }> = [];
const dbUpdates: Array<{ table?: unknown; set: unknown }> = [];
function makeStubDb() {
  return {
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        dbInserts.push({ table, values });
        return {
          run: () => {},
          onConflictDoUpdate: () => ({ run: () => {} }),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: unknown) => {
        dbUpdates.push({ table, set });
        return {
          where: () => ({ run: () => {} }),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ get: () => null, all: () => [] }),
          get: () => null,
          all: () => [],
        }),
      }),
    }),
    transaction: (fn: (tx: unknown) => unknown) => fn(makeStubDb()),
  };
}
const stubDb = makeStubDb();
mock.module("../db-connection.js", () => ({
  getDb: () => stubDb,
}));

// Now load the real modules under test.
const { isMemoryEnabled } = await import("../jobs-store.js");
const { enqueueAutoAnalysisIfEnabled } = await import(
  "../auto-analysis-enqueue.js"
);
const { enqueueMemoryRetrospectiveIfEnabled } = await import(
  "../memory-retrospective-enqueue.js"
);

beforeEach(() => {
  dbInserts.length = 0;
  dbUpdates.length = 0;
  memoryEnabled = true;
  getConfigThrows = false;
});

// ---------------------------------------------------------------------
// isMemoryEnabled() contract
// ---------------------------------------------------------------------

describe("isMemoryEnabled", () => {
  test("returns true when memory.enabled is true", () => {
    memoryEnabled = true;
    expect(isMemoryEnabled()).toBe(true);
  });

  test("returns true when memory.enabled is undefined (schema default)", () => {
    memoryEnabled = undefined;
    expect(isMemoryEnabled()).toBe(true);
  });

  test("returns true when memory key is absent (partial config)", () => {
    memoryEnabled = null;
    expect(isMemoryEnabled()).toBe(true);
  });

  test("returns false ONLY when memory.enabled is explicitly false", () => {
    memoryEnabled = false;
    expect(isMemoryEnabled()).toBe(false);
  });

  test("returns true (defensive) when getConfig throws", () => {
    // If config can't be read, we can't tell whether memory has been
    // disabled, so default to "enabled". Callers that already have their
    // own getConfig try/catch (e.g. enqueueAutoAnalysisIfEnabled) keep
    // controlling the silent-failure semantic for the rest of their flow.
    getConfigThrows = true;
    expect(isMemoryEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------
// enqueueAutoAnalysisIfEnabled — representative entry-point helper
// ---------------------------------------------------------------------

describe("enqueueAutoAnalysisIfEnabled (call-site gate)", () => {
  test("does NOT enqueue when memory.enabled is false", () => {
    memoryEnabled = false;
    enqueueAutoAnalysisIfEnabled({
      conversationId: "conv-1",
      trigger: "batch",
    });
    expect(dbInserts.length).toBe(0);
  });

  test("enqueues when memory.enabled is true", () => {
    memoryEnabled = true;
    enqueueAutoAnalysisIfEnabled({
      conversationId: "conv-1",
      trigger: "batch",
    });
    expect(dbInserts.length).toBeGreaterThan(0);
  });

  test("enqueues when memory.enabled is undefined (schema default)", () => {
    memoryEnabled = undefined;
    enqueueAutoAnalysisIfEnabled({
      conversationId: "conv-1",
      trigger: "batch",
    });
    expect(dbInserts.length).toBeGreaterThan(0);
  });

  test("enqueues when memory key is absent from config", () => {
    memoryEnabled = null;
    enqueueAutoAnalysisIfEnabled({
      conversationId: "conv-1",
      trigger: "batch",
    });
    expect(dbInserts.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------
// enqueueMemoryRetrospectiveIfEnabled — representative entry-point
// ---------------------------------------------------------------------

describe("enqueueMemoryRetrospectiveIfEnabled (call-site gate)", () => {
  test("does NOT enqueue when memory.enabled is false", () => {
    memoryEnabled = false;
    enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "conv-1",
      trigger: "interval",
    });
    expect(dbInserts.length).toBe(0);
  });

  test("enqueues when memory.enabled is true", () => {
    memoryEnabled = true;
    enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "conv-1",
      trigger: "interval",
    });
    expect(dbInserts.length).toBeGreaterThan(0);
  });

  test("enqueues when memory.enabled is undefined (schema default)", () => {
    memoryEnabled = undefined;
    enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "conv-1",
      trigger: "interval",
    });
    expect(dbInserts.length).toBeGreaterThan(0);
  });
});
