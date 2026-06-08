/**
 * Tests for `shadow-plugin.ts` (section-lane pipeline).
 *
 * The v3 plugin is flag-gated. These tests assert:
 *   - both flags OFF → orchestrate is never called and no DB rows are written;
 *   - either flag ON → orchestrate runs and selection rows land in
 *     `memory_v3_selections` with the new lane source tags;
 *   - shadow-only (live off) → the injector returns `null` (never mutates the
 *     turn) but still logs;
 *   - live on → the injector returns the rendered `<memory>` block;
 *   - an empty selection under live → `null`;
 *   - lazy-init runs the lane builders only once across multiple turns, and
 *     `invalidateLanes` forces exactly one rebuild.
 *
 * All heavy dependencies (config, flag resolver, conversation reads, v2 page
 * index + page store, the lane builders, orchestrate) are mocked BEFORE
 * importing the plugin so the module observes them at load time. A real
 * in-memory SQLite DB backs the write assertions via the
 * `memory_v3_selections` migration.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateAddMemoryV3Selections } from "../../../../memory/migrations/268-add-memory-v3-selections.js";
import * as schema from "../../../../memory/schema.js";
import type { SectionIndex, SelectionSource } from "../types.js";

// `mock.module` is process-global and, in Bun, neither `mock.restore()` nor a
// re-mock in `afterAll` reverts it for files that load LATER in the same
// `bun test src/plugins/defaults/memory-v3-shadow/` run. Sibling files import
// these same modules for real, so an unconditional stub here would leak in and
// break them. Instead each stub below DELEGATES to the real implementation
// unless this test is actively running (`shadowMockActive`, toggled in
// beforeEach/afterAll).
//
// Snapshot the real exports into plain objects NOW: a module namespace object
// is a live view, so reading the real export *after* the stub is installed
// would resolve back to the stub (infinite recursion).
const realSections = { ...(await import("../sections.js")) };
const realSectionNeedle = { ...(await import("../section-needle.js")) };
const realEdge = { ...(await import("../edge.js")) };
const realSectionDenseStore = {
  ...(await import("../section-dense-store.js")),
};
const realOrchestrate = { ...(await import("../orchestrate.js")) };
const realPlatform = { ...(await import("../../../../util/platform.js")) };
const realPageStore = {
  ...(await import("../../../../memory/v2/page-store.js")),
};
const realConversationCrud = {
  ...(await import("../../../../memory/conversation-crud.js")),
};

let shadowMockActive = false;

// ─── mutable test state, read by the mocks below ────────────────────────────

let liveEnabled = false;
let shadowEnabled = false;
let messages: Array<{ role: string; content: string }> = [];

// The orchestrate result the spy returns. page-1 + page-2 matched a section
// this turn (→ "needle"); page-3 is an edge-only candidate (no matched section
// → "edge"); carried is a carry-forward slug not re-selected this turn.
const orchestrateSpy = mock(async () => ({
  currentSelections: [
    { slug: "page-1", pinned: true },
    { slug: "page-2", pinned: false },
    { slug: "page-3", pinned: false },
  ],
  workingSetUnion: new Set<string>(["page-1", "page-2", "page-3"]),
  finalInjection: ["page-1", "page-2", "page-3", "carried"],
  sectionBySlug: new Map([
    ["page-1", { article: "page-1", title: "", text: "x", ordinal: 0 }],
    ["page-2", { article: "page-2", title: "", text: "y", ordinal: 0 }],
  ]),
}));

let sectionBuilds = 0;
let needleBuilds = 0;
let edgeBuilds = 0;
let ensureCollectionCalls = 0;

// Shared in-memory DB so writes are observable from the test.
let testSqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  testSqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(testSqlite, { schema });
  migrateAddMemoryV3Selections(db);
  return db;
}

const FAKE_SECTION_INDEX: SectionIndex = {
  sections: [],
  byArticle: new Map(),
};

// ─── module mocks (installed before the plugin import) ──────────────────────

mock.module("../../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) =>
    key === "memory-v3-live"
      ? liveEnabled
      : key === "memory-v3-shadow"
        ? shadowEnabled
        : false,
}));

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({
    memory: {
      v3: {
        workingSet: { maxPages: 150, evictWindow: 5 },
        needleK: 100,
        denseK: 100,
        edge: { hubDegree: 30, seedCount: 18, perSeed: 6, cap: 45 },
      },
      qdrant: { vectorSize: 8, onDisk: false },
    },
  }),
}));

// Spread the real module so every export the live path transitively imports
// stays present; only `getMessages` is overridden.
mock.module("../../../../memory/conversation-crud.js", () => ({
  ...realConversationCrud,
  getMessages: () => messages.map((m, i) => ({ ...m, id: `m${i}` })),
}));

mock.module("../../../../memory/db-connection.js", () => ({
  getDb: () => testDb,
  getSqliteFrom: () => testSqlite,
}));

mock.module("../../../../memory/v2/page-index.js", () => ({
  getPageIndex: async () => ({
    entries: [
      {
        slug: "page-1",
        id: 1,
        summary: "",
        edges: [],
        leaves: [],
        modifiedAt: 0,
      },
      {
        slug: "page-2",
        id: 2,
        summary: "",
        edges: [],
        leaves: [],
        modifiedAt: 0,
      },
    ],
    bySlug: new Map(),
  }),
}));

// `pageContent` (live mode) reads the full page via `readPage`/`renderPageContent`.
mock.module("../../../../memory/v2/page-store.js", () => ({
  ...realPageStore,
  readPage: async (workspaceDir: string, slug: string) =>
    shadowMockActive
      ? { slug, frontmatter: {}, body: `body for ${slug}` }
      : realPageStore.readPage(workspaceDir, slug),
  renderPageContent: (page: { slug: string; body: string }) =>
    shadowMockActive
      ? page.body
      : realPageStore.renderPageContent(
          page as Parameters<typeof realPageStore.renderPageContent>[0],
        ),
}));

mock.module("../../../../util/platform.js", () => ({
  ...realPlatform,
  getWorkspaceDir: () =>
    shadowMockActive
      ? "/tmp/shadow-test-workspace"
      : realPlatform.getWorkspaceDir(),
}));

mock.module("../sections.js", () => ({
  ...realSections,
  buildSectionIndex: async (
    ...args: Parameters<typeof realSections.buildSectionIndex>
  ) => {
    if (!shadowMockActive) return realSections.buildSectionIndex(...args);
    sectionBuilds++;
    return FAKE_SECTION_INDEX;
  },
}));

mock.module("../section-needle.js", () => ({
  ...realSectionNeedle,
  buildSectionNeedle: (
    ...args: Parameters<typeof realSectionNeedle.buildSectionNeedle>
  ) => {
    if (!shadowMockActive) return realSectionNeedle.buildSectionNeedle(...args);
    needleBuilds++;
    return { query: () => [], bestSection: () => -1 };
  },
}));

mock.module("../edge.js", () => ({
  ...realEdge,
  buildEdgeGraph: async (
    ...args: Parameters<typeof realEdge.buildEdgeGraph>
  ) => {
    if (!shadowMockActive) return realEdge.buildEdgeGraph(...args);
    edgeBuilds++;
    return { adjacency: new Map(), hubs: new Set(), slugs: new Set() };
  },
}));

mock.module("../section-dense-store.js", () => ({
  ...realSectionDenseStore,
  ensureSectionCollection: async (
    ...args: Parameters<typeof realSectionDenseStore.ensureSectionCollection>
  ) => {
    if (!shadowMockActive) {
      return realSectionDenseStore.ensureSectionCollection(...args);
    }
    ensureCollectionCalls++;
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
const { runShadowObservation, resetShadowLanesForTests, invalidateLanes } =
  await import("../shadow-plugin.js");
const { memoryV3Injector } = await import("../injector.js");

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
  liveEnabled = false;
  shadowEnabled = false;
  messages = [
    {
      role: "user",
      content: JSON.stringify([{ type: "text", text: "hello world" }]),
    },
  ];
  orchestrateSpy.mockClear();
  sectionBuilds = 0;
  needleBuilds = 0;
  edgeBuilds = 0;
  ensureCollectionCalls = 0;
  testDb = makeDb();
  resetShadowLanesForTests();
});

/** Invoke the memory-v3 injector's `produce()` for a turn. */
function produce(conversationId: string, turnIndex: number) {
  return memoryV3Injector.produce({
    requestId: "r1",
    conversationId,
    turnIndex,
    trust: {} as never,
  });
}

describe("memory-v3 shadow plugin", () => {
  test("shadow flag OFF → orchestrate not called, no DB writes", async () => {
    shadowEnabled = false;
    await runShadowObservation("conv-1", 0);
    expect(orchestrateSpy).not.toHaveBeenCalled();
    expect(sectionBuilds).toBe(0);
    expect(readRows()).toHaveLength(0);
  });

  test("shadow flag ON → orchestrate runs and rows are written with lane sources", async () => {
    shadowEnabled = true;
    await runShadowObservation("conv-1", 2);

    expect(orchestrateSpy).toHaveBeenCalledTimes(1);
    const rows = readRows();
    expect(rows).toEqual([
      { slug: "carried", source: "carry-forward", pinned: 0 },
      // page-1 matched a section this turn → "needle", pinned.
      { slug: "page-1", source: "needle", pinned: 1 },
      // page-2 matched a section this turn → "needle".
      { slug: "page-2", source: "needle", pinned: 0 },
      // page-3 had no matched section (edge-only) → "edge".
      { slug: "page-3", source: "edge", pinned: 0 },
    ]);
  });

  test("the turn passed to orchestrate carries the latest user message", async () => {
    shadowEnabled = true;
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

  test("orchestrate receives the lane deps", async () => {
    shadowEnabled = true;
    await runShadowObservation("conv-1", 0);
    const deps = (
      orchestrateSpy.mock.calls as unknown as unknown[][]
    )[0]![1] as {
      sectionIndex?: unknown;
      needle?: unknown;
      edgeGraph?: unknown;
      workingSet?: unknown;
      capabilitySlugs?: unknown;
    };
    expect(deps.sectionIndex).toBeDefined();
    expect(deps.needle).toBeDefined();
    expect(deps.edgeGraph).toBeDefined();
    expect(deps.workingSet).toBeDefined();
    expect(Array.isArray(deps.capabilitySlugs)).toBe(true);
  });

  test("both flags OFF → produce returns null, no orchestrate, no writes", async () => {
    liveEnabled = false;
    shadowEnabled = false;
    const block = await produce("conv-1", 0);
    expect(block).toBeNull();
    expect(orchestrateSpy).not.toHaveBeenCalled();
    expect(readRows()).toHaveLength(0);
  });

  test("shadow-only (live off) → produce returns null but still logs", async () => {
    liveEnabled = false;
    shadowEnabled = true;
    const block = await produce("conv-1", 0);
    expect(block).toBeNull();
    expect(orchestrateSpy).toHaveBeenCalledTimes(1);
    expect(readRows().length).toBeGreaterThan(0);
  });

  test("live on → produce returns the rendered <memory> block and logs", async () => {
    liveEnabled = true;
    shadowEnabled = false;
    const block = await produce("conv-1", 0);
    expect(block).not.toBeNull();
    expect(block!.placement).toBe("after-memory-prefix");
    expect(block!.text.startsWith("<memory>\n")).toBe(true);
    expect(block!.text.endsWith("\n</memory>")).toBe(true);
    // Progressive disclosure: a slug with a matched section renders that
    // section's text (page-1 → "x"), NOT the full page body.
    expect(block!.text).toContain("# memory/concepts/page-1.md\nx");
    expect(block!.text).not.toContain("body for page-1");
    // A slug with no matched section (carry-forward) falls back to the full body.
    expect(block!.text).toContain("body for carried");
    // Selections are still logged in live mode.
    expect(readRows().length).toBeGreaterThan(0);
  });

  test("live on but empty selection → produce returns null", async () => {
    liveEnabled = true;
    shadowEnabled = false;
    orchestrateSpy.mockImplementationOnce(async () => ({
      currentSelections: [],
      workingSetUnion: new Set<string>(),
      finalInjection: [],
      sectionBySlug: new Map(),
    }));
    const block = await produce("conv-1", 0);
    expect(block).toBeNull();
    expect(orchestrateSpy).toHaveBeenCalledTimes(1);
    expect(readRows()).toHaveLength(0);
  });

  test("lazy-init runs the lane builders only once across turns", async () => {
    shadowEnabled = true;
    await runShadowObservation("conv-1", 0);
    await runShadowObservation("conv-1", 1);
    await runShadowObservation("conv-1", 2);
    expect(sectionBuilds).toBe(1);
    expect(needleBuilds).toBe(1);
    expect(edgeBuilds).toBe(1);
    expect(ensureCollectionCalls).toBe(1);
    expect(orchestrateSpy).toHaveBeenCalledTimes(3);
  });

  test("invalidateLanes forces a one-time rebuild on the next turn", async () => {
    shadowEnabled = true;
    await runShadowObservation("conv-1", 0);
    await runShadowObservation("conv-1", 1);
    expect(sectionBuilds).toBe(1);
    expect(needleBuilds).toBe(1);

    invalidateLanes();

    await runShadowObservation("conv-1", 2);
    expect(sectionBuilds).toBe(2);
    expect(needleBuilds).toBe(2);
    expect(edgeBuilds).toBe(2);

    // ...and the rebuild is memoized again — no further builds until the next
    // invalidation.
    await runShadowObservation("conv-1", 3);
    expect(sectionBuilds).toBe(2);
    expect(needleBuilds).toBe(2);
  });

  test("resetShadowLanesForTests invalidates like invalidateLanes", async () => {
    shadowEnabled = true;
    await runShadowObservation("conv-1", 0);
    expect(sectionBuilds).toBe(1);

    resetShadowLanesForTests();

    await runShadowObservation("conv-1", 1);
    expect(sectionBuilds).toBe(2);
  });

  test("concurrent first turns after invalidation share a single build", async () => {
    shadowEnabled = true;
    await runShadowObservation("conv-1", 0);
    expect(sectionBuilds).toBe(1);

    invalidateLanes();

    await Promise.all([
      runShadowObservation("conv-1", 1),
      runShadowObservation("conv-1", 2),
    ]);
    expect(sectionBuilds).toBe(2);
    expect(needleBuilds).toBe(2);
  });

  test("no user message → no orchestrate, no writes", async () => {
    shadowEnabled = true;
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
