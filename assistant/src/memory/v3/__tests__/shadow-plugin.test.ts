/**
 * Tests for `assistant/src/memory/v3/shadow-plugin.ts`.
 *
 * The shadow plugin is flag-gated, observation-only, and MUST NOT modify the
 * injected context. These tests assert:
 *   - flag OFF → orchestrate is never called and no DB rows are written;
 *   - flag ON  → orchestrate runs and selection rows land in
 *     `memory_v3_selections`;
 *   - the injector always returns `null` (never mutates the turn);
 *   - lazy-init runs the loaders only once across multiple turns.
 *
 * All heavy dependencies (config, flag resolver, conversation reads, v2 page
 * index, v3 loaders, orchestrate) are mocked BEFORE importing the plugin so
 * the module observes them at load time. A real in-memory SQLite DB backs the
 * write assertions via the `memory_v3_selections` migration.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateAddMemoryV3Selections } from "../../migrations/268-add-memory-v3-selections.js";
import * as schema from "../../schema.js";
import type { LeafTree, SelectionSource } from "../types.js";

// `mock.module` is process-global and, in Bun, neither `mock.restore()` nor a
// re-mock in `afterAll` reverts it for files that load LATER in the same
// `bun test src/memory/v3/` run. Sibling files (orchestrate.test.ts,
// tree.test.ts) import these same modules for real, so an unconditional stub
// here would leak in and break them. Instead each stub below DELEGATES to the
// real implementation unless this test is actively running (`shadowMockActive`,
// toggled in beforeEach/afterAll).
//
// Snapshot the real exports into plain objects NOW: a module namespace object
// is a live view, so reading `realTree.loadLeafTree` *after* the stub is
// installed would resolve back to the stub (infinite recursion).
const realTree = { ...(await import("../tree.js")) };
const realCore = { ...(await import("../core.js")) };
const realNeedle = { ...(await import("../needle.js")) };
const realOrchestrate = { ...(await import("../orchestrate.js")) };
const realPlatform = { ...(await import("../../../util/platform.js")) };

let shadowMockActive = false;

// ─── mutable test state, read by the mocks below ────────────────────────────

let flagEnabled = false;
let messages: Array<{ role: string; content: string }> = [];
const orchestrateSpy = mock(async () => ({
  openedLeaves: [],
  currentSelections: [
    { slug: "domain-a/page-1", pinned: true },
    { slug: "domain-b/page-2", pinned: false },
  ],
  workingSetUnion: new Set<string>(["domain-a/page-1", "domain-b/page-2"]),
  finalInjection: ["domain-a/page-1", "domain-b/page-2", "domain-a/carried"],
}));
let treeLoads = 0;
let coreLoads = 0;
let needleBuilds = 0;

// Shared in-memory DB so writes are observable from the test. We hold the raw
// sqlite handle alongside the drizzle wrapper so the test can both read rows
// directly and feed the same handle through the mocked `getSqliteFrom`.
let testSqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  testSqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(testSqlite, { schema });
  migrateAddMemoryV3Selections(db);
  return db;
}

// A tree where `domain-a/*` pages are owned by a core leaf and `domain-b/*`
// are not, so attribution maps to core+l2 / l1+l2 respectively.
const FAKE_TREE = {
  leaves: new Map([
    ["domain-a", { members: ["domain-a/page-1", "domain-a/carried"] }],
    ["domain-b", { members: ["domain-b/page-2"] }],
  ]),
  byPage: new Map(),
} as unknown as LeafTree;

// ─── module mocks (installed before the plugin import) ──────────────────────

mock.module("../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => flagEnabled,
}));

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({
    memory: { v3: { workingSet: { maxPages: 150, evictWindow: 5 } } },
  }),
}));

mock.module("../../conversation-crud.js", () => ({
  getMessages: () => messages.map((m, i) => ({ ...m, id: `m${i}` })),
}));

mock.module("../../db-connection.js", () => ({
  getDb: () => testDb,
  getSqliteFrom: () => testSqlite,
}));

mock.module("../v2/page-index.js", () => ({
  getPageIndex: async () => ({ bySlug: new Map() }),
}));

mock.module("../../../util/platform.js", () => ({
  ...realPlatform,
  getWorkspaceDir: () =>
    shadowMockActive
      ? "/tmp/shadow-test-workspace"
      : realPlatform.getWorkspaceDir(),
}));

mock.module("../tree.js", () => ({
  ...realTree,
  resolveDataDir: () =>
    shadowMockActive ? "/tmp/shadow-test-data" : realTree.resolveDataDir(),
  loadLeafTree: async (dataDir: string) => {
    if (!shadowMockActive) return realTree.loadLeafTree(dataDir);
    treeLoads++;
    return FAKE_TREE;
  },
  membersOf: (tree: LeafTree, leaf: string) =>
    shadowMockActive
      ? ((tree.leaves.get(leaf) as unknown as { members?: string[] })
          ?.members ?? [])
      : realTree.membersOf(tree, leaf),
}));

mock.module("../core.js", () => ({
  ...realCore,
  loadCore: async (dataDir: string) => {
    if (!shadowMockActive) return realCore.loadCore(dataDir);
    coreLoads++;
    return new Set(["domain-a"]);
  },
}));

mock.module("../needle.js", () => ({
  ...realNeedle,
  buildNeedleIndex: async (
    ...args: Parameters<typeof realNeedle.buildNeedleIndex>
  ) => {
    if (!shadowMockActive) return realNeedle.buildNeedleIndex(...args);
    needleBuilds++;
    return { query: () => [] } as unknown as Awaited<
      ReturnType<typeof realNeedle.buildNeedleIndex>
    >;
  },
}));

mock.module("../orchestrate.js", () => ({
  ...realOrchestrate,
  orchestrate: (...args: Parameters<typeof realOrchestrate.orchestrate>) =>
    shadowMockActive
      ? orchestrateSpy(...(args as unknown as []))
      : realOrchestrate.orchestrate(...args),
}));

// Import AFTER mocks so the plugin binds to them.
const { runShadowObservation, resetShadowLanesForTests, memoryV3ShadowPlugin } =
  await import("../shadow-plugin.js");

// The module stubs above stay installed for the rest of the process (Bun can't
// reliably uninstall them), but `shadowMockActive` gates their fake behavior to
// this file's tests only, so later-loaded sibling files see real behavior.
afterAll(() => {
  shadowMockActive = false;
});

function readRows() {
  return testSqlite
    .query(
      `SELECT slug, source, pinned FROM memory_v3_selections ORDER BY slug`,
    )
    .all() as Array<{ slug: string; source: SelectionSource; pinned: number }>;
}

beforeEach(() => {
  shadowMockActive = true;
  flagEnabled = false;
  messages = [
    {
      role: "user",
      content: JSON.stringify([{ type: "text", text: "hello world" }]),
    },
  ];
  orchestrateSpy.mockClear();
  treeLoads = 0;
  coreLoads = 0;
  needleBuilds = 0;
  testDb = makeDb();
  resetShadowLanesForTests();
});

describe("memory-v3 shadow plugin", () => {
  test("flag OFF → orchestrate not called, no DB writes", async () => {
    flagEnabled = false;
    await runShadowObservation("conv-1", 0);
    expect(orchestrateSpy).not.toHaveBeenCalled();
    expect(treeLoads).toBe(0);
    expect(readRows()).toHaveLength(0);
  });

  test("flag ON → orchestrate runs and rows are written", async () => {
    flagEnabled = true;
    await runShadowObservation("conv-1", 2);

    expect(orchestrateSpy).toHaveBeenCalledTimes(1);
    const rows = readRows();
    expect(rows).toEqual([
      { slug: "domain-a/carried", source: "carry-forward", pinned: 0 },
      // page-1 belongs to the core leaf `domain-a` → core+l2, pinned.
      { slug: "domain-a/page-1", source: "core+l2", pinned: 1 },
      // page-2 belongs to non-core `domain-b` → l1+l2.
      { slug: "domain-b/page-2", source: "l1+l2", pinned: 0 },
    ]);
  });

  test("the turn passed to orchestrate carries the latest user message", async () => {
    flagEnabled = true;
    await runShadowObservation("conv-1", 0);
    const turn = (
      orchestrateSpy.mock.calls as unknown as unknown[][]
    )[0]![0] as {
      conversationId: string;
      turnNumber: number;
      currentMessage: string;
    };
    expect(turn.conversationId).toBe("conv-1");
    expect(turn.turnNumber).toBe(0);
    expect(turn.currentMessage).toBe("hello world");
  });

  test("injector always returns null (never mutates the turn)", async () => {
    flagEnabled = true;
    const injector = memoryV3ShadowPlugin.injectors![0]!;
    const block = await injector.produce({
      requestId: "r1",
      conversationId: "conv-1",
      turnIndex: 0,
      trust: {} as never,
    });
    expect(block).toBeNull();
  });

  test("lazy-init runs the loaders only once across turns", async () => {
    flagEnabled = true;
    await runShadowObservation("conv-1", 0);
    await runShadowObservation("conv-1", 1);
    await runShadowObservation("conv-1", 2);
    expect(treeLoads).toBe(1);
    expect(coreLoads).toBe(1);
    expect(needleBuilds).toBe(1);
    expect(orchestrateSpy).toHaveBeenCalledTimes(3);
  });

  test("no user message → no orchestrate, no writes", async () => {
    flagEnabled = true;
    messages = [
      {
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "hi" }]),
      },
    ];
    await runShadowObservation("conv-1", 0);
    expect(orchestrateSpy).not.toHaveBeenCalled();
    expect(readRows()).toHaveLength(0);
  });
});
