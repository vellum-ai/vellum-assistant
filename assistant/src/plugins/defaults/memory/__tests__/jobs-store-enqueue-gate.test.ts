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
// smoke-test (2) at a central entry-point helper:
//   - `enqueueMemoryRetrospectiveIfEnabled`
// Each call site re-checks `isMemoryEnabled()` itself, so we don't
// repeat 30+ identical scenarios — the helper test is the contract.

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mutable config shape, mutated per-test. `null` means "no `memory` key
// at all" — exercises the defensive `?.` chain in `isMemoryEnabled`.
type MemoryEnabledShape = boolean | null | undefined;
let memoryEnabled: MemoryEnabledShape = true;
let getConfigThrows = false;
mock.module("../../../../config/loader.js", () => ({
  getConfig: () => {
    if (getConfigThrows) throw new Error("config load failed");
    if (memoryEnabled === null) return {};
    return {
      memory: { enabled: memoryEnabled, v2: { enabled: false } },
    };
  },
}));

// Stub the conversation-source lookup so the recursion guard in the
// retrospective path falls through to the enqueue. `getConversation`
// returning null keeps `isLowYieldRetrospectiveSource` false, so the
// retrospective is enqueued rather than skipped.
mock.module("../../../../persistence/conversation-crud.js", () => ({
  getConversation: () => null,
  getConversationSource: () => null,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

// Stub the qdrant breaker so `enqueueMemoryJob` doesn't trip on it.
mock.module(
  "../../../../persistence/embeddings/qdrant-circuit-breaker.js",
  () => ({
    isQdrantBreakerOpen: () => false,
    shouldAllowQdrantProbe: () => true,
  }),
);

// Stub raw query helpers (used by jobs-store internally).
mock.module("../../../../persistence/raw-query.js", () => ({
  rawAll: () => [],
  rawChanges: () => 0,
  rawMemoryAll: () => [],
  rawMemoryChanges: () => 0,
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
mock.module("../../../../persistence/db-connection.js", () => ({
  getDb: () => stubDb,
  getMemoryDb: () => stubDb,
}));

// Now load the real modules under test.
const { isMemoryEnabled } =
  await import("../../../../persistence/jobs-store.js");
const { enqueueMemoryRetrospectiveIfEnabled } =
  await import("../memory-retrospective-enqueue.js");

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
    // own getConfig try/catch keep controlling the silent-failure
    // semantic for the rest of their flow.
    getConfigThrows = true;
    expect(isMemoryEnabled()).toBe(true);
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
