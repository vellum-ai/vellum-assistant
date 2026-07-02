/**
 * Tests for `shadow-plugin.ts` (section-lane pipeline).
 *
 * These tests assert the v3 orchestration engine and the live injector:
 *   - {@link observeTurn} runs orchestration and selection rows land in
 *     `memory_v3_selections` with the new lane source tags;
 *   - {@link observeTurn} is skipped when global memory is disabled;
 *   - live on → the injector returns the rendered `<memory>` block;
 *   - an empty selection under live → `null`;
 *   - lazy-init runs the lane builders only once across multiple turns, and
 *     `invalidateLanes` forces exactly one rebuild;
 *   - `initLanes` feeds synthetic capability pages (skills / CLI commands) into
 *     the section index via `renderCapabilityContent`, so the needle lane ranks
 *     them like any other page (they are no longer always-added to the pool).
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

import { MemoryV3GateSchema } from "../../../../../config/schemas/memory-v3.js";
import { migrateAddMemoryV3Selections } from "../../../../../persistence/migrations/268-add-memory-v3-selections.js";
import { migrateAddMemoryV3EverInjected } from "../../../../../persistence/migrations/277-add-memory-v3-ever-injected.js";
import { migrateMemoryV3SelectionsMessageIdAndSections } from "../../../../../persistence/migrations/283-memory-v3-selections-message-id-and-sections.js";
import * as schema from "../../../../../persistence/schema/index.js";
import type { HotSetEntry, HotSetOptions } from "../hot-set.js";
import type { OrchestrateResult } from "../orchestrate.js";
import { MEMORY_V3_FULL_PROFILE_MIN_PAGES } from "../tuning-profile.js";
import {
  MEMORY_V3_COMMIT_META_KEY,
  type MemoryRoutingTurn,
  type SectionIndex,
  type SelectionSource,
} from "../types.js";

// `mock.module` is process-global and, in Bun, neither `mock.restore()` nor a
// re-mock in `afterAll` reverts it for files that load LATER in the same
// `bun test src/plugins/defaults/memory/v3/` run. Sibling files import
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
const realLearnedEdges = { ...(await import("../learned-edges.js")) };
const realPlatform = { ...(await import("../../../../../util/platform.js")) };
const realPageStore = {
  ...(await import("../../v2/page-store.js")),
};
const realConversationCrud = {
  ...(await import("../../../../../persistence/conversation-crud.js")),
};
const realSkillStore = {
  ...(await import("../../v2/skill-store.js")),
};
const realCliCommandStore = {
  ...(await import("../../v2/cli-command-store.js")),
};
const realCoreSet = { ...(await import("../core-set.js")) };
const realHotSet = { ...(await import("../hot-set.js")) };

let shadowMockActive = false;

// ─── mutable test state, read by the mocks below ────────────────────────────

let liveEnabled = false;
let memoryEnabled = true;
let learnedEdgesCap = 0;
// Synthetic real concept pages (modifiedAt > 0) appended to the mocked page
// index so a test can cross the v3 full-profile page threshold; 0 → sparse
// corpus, lean profile.
let extraRealConceptPages = 0;
// Mutable mocked config knob (orchestrate-only) for asserting per-turn tuning
// re-resolution from a live config edit.
let selectorEnabledCfg = false;
// Drives the `memory-v3-injection-gate` feature flag through the shared
// assistant-feature-flags mock below (default off).
let gateFlagEnabled = false;
// Mutable `memory.v3.gate.enabled` config kill-switch carried by the mocked
// config (default on, mirroring the schema default).
let gateEnabledCfg = true;
let messages: Array<{ role: string; content: string }> = [];

// Schema defaults for `memory.v3.gate` (the tuning the mocked config carries
// and the gate-config threading test asserts against). Includes the default-on
// `enabled` kill-switch; `observeTurn` overwrites `enabled` with the effective
// flag AND config value.
const GATE_DEFAULTS = MemoryV3GateSchema.parse({});

// A synthetic skill capability slug the page index carries. Its rendered
// content holds a distinctive term ("kumquat") so the real needle, built over
// the section index `initLanes` feeds, ranks it. Generic placeholder only.
const CAPABILITY_SLUG = "skills/example";
const CAPABILITY_CONTENT = "use the kumquat skill to do the thing";

// The orchestrate result the spy returns. `lanes` records where each pooled
// slug lived: page-core in the core lane, page-hot in the hot lane, page-fresh
// in the fresh lane, and the finder entries page-1 → "needle", page-2 → "dense",
// page-3 → "edge";
// `attributeSelections` reads it directly. `matchedSections` carries the
// matched section for the slugs that had one (page-1/page-2) — consumed by the
// live injector's progressive disclosure, independent of source attribution.
const orchestrateSpy = mock(
  async (): Promise<OrchestrateResult> => ({
    selections: [
      { slug: "page-core", pinned: false },
      { slug: "page-hot", pinned: false },
      { slug: "page-fresh", pinned: false },
      { slug: "page-1", pinned: true },
      { slug: "page-2", pinned: false },
      { slug: "page-3", pinned: false },
      { slug: "page-4", pinned: false },
      { slug: "page-5", pinned: false },
    ],
    matchedSections: new Map([
      ["page-1", { article: "page-1", title: "", text: "x", ordinal: 0 }],
      ["page-2", { article: "page-2", title: "", text: "y", ordinal: 0 }],
    ]),
    lanes: {
      core: ["page-core"],
      hot: ["page-hot"],
      fresh: ["page-fresh"],
      finder: [
        { slug: "page-1", descriptor: "", lane: "needle" },
        { slug: "page-2", descriptor: "", lane: "dense" },
        { slug: "page-3", descriptor: "", lane: "edge" },
        { slug: "page-4", descriptor: "", lane: "reply" },
        { slug: "page-5", descriptor: "", lane: "learned" },
      ],
    },
  }),
);

let sectionBuilds = 0;
let needleBuilds = 0;
let edgeBuilds = 0;
let learnedGraphBuilds = 0;
let ensureCollectionCalls = 0;
let ensureCollectionThrows = false;

// Stable-prefix lane inputs, driven per test: what the curated core file
// yields and what the frecency hot set computes. `hotSetOpts` captures the
// options `initLanes` passed so the test can assert the core exclusion and the
// config plumbing.
let coreSetSlugs: string[] = [];
let hotSetResult: HotSetEntry[] = [];
let hotSetOpts: HotSetOptions | null = null;

// The `pageBody` resolver `initLanes` passes to `buildSectionIndex` (its second
// arg), captured by the stub below so a test can drive it directly: a capability
// slug must resolve to its rendered capability content, an on-disk slug to its
// page body.
let capturedPageBody: ((slug: string) => Promise<string>) | null = null;

// Shared in-memory DB so writes are observable from the test.
let testSqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  testSqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(testSqlite, { schema });
  migrateAddMemoryV3Selections(db);
  migrateMemoryV3SelectionsMessageIdAndSections(db);
  // The live injector's net-new dedup reads/writes the everInjected store.
  migrateAddMemoryV3EverInjected(db);
  return db;
}

// The fake index lists the LIVE pages — `initLanes` filters the core and hot
// lanes against `byArticle`, so membership here is what "the page exists"
// means to the stable-prefix lanes.
const FAKE_SECTION_INDEX: SectionIndex = {
  sections: [],
  byArticle: new Map([
    ["page-1", []],
    ["page-2", []],
    [CAPABILITY_SLUG, []],
  ]),
};

// ─── module mocks (installed before the plugin import) ──────────────────────

mock.module("../../../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) =>
    key === "memory-v3-live"
      ? liveEnabled
      : key === "memory-v3-injection-gate"
        ? gateFlagEnabled
        : false,
}));

mock.module("../../../../../config/loader.js", () => ({
  getConfig: () => ({
    memory: {
      enabled: memoryEnabled,
      v3: {
        live: liveEnabled,
        hotSet: { k: 8, halfLifeDays: 14 },
        freshSet: { k: 8 },
        spotlight: { n: 6, windowTurns: 2 },
        needleK: 12,
        denseK: 0,
        replyQueryK: 0,
        selectorEnabled: selectorEnabledCfg,
        learnedEdges: {
          halfLifeDays: 30,
          minCount: 3,
          npmiFloor: 0.2,
          maxPerPage: 6,
          perSeed: 3,
          cap: learnedEdgesCap,
        },
        edge: { hubDegree: 30, seedCount: 6, perSeed: 1, cap: 6 },
        entity: { enabled: true, idfFloor: 4, cap: 8 },
        // Gate tuning (schema defaults) with the mutable `enabled` kill-switch;
        // `observeTurn` spreads this and overwrites `enabled` with the effective
        // flag AND config value before passing to orchestrate.
        gate: { ...GATE_DEFAULTS, enabled: gateEnabledCfg },
      },
      qdrant: { vectorSize: 8, onDisk: false },
    },
  }),
}));

// Stable-prefix lanes: the curated core loader and the frecency hot set are
// stubbed to controllable values; `initLanes` owns the existence filtering and
// the core exclusion these tests assert.
mock.module("../core-set.js", () => ({
  ...realCoreSet,
  loadCoreSet: (...args: Parameters<typeof realCoreSet.loadCoreSet>) =>
    shadowMockActive ? coreSetSlugs : realCoreSet.loadCoreSet(...args),
}));

mock.module("../hot-set.js", () => ({
  ...realHotSet,
  computeHotSet: (
    ...args: Parameters<typeof realHotSet.computeHotSet>
  ): HotSetEntry[] => {
    if (!shadowMockActive) return realHotSet.computeHotSet(...args);
    hotSetOpts = args[1];
    return hotSetResult;
  },
}));

// Spread the real module so every export the live path transitively imports
// stays present; only `getMessages` is overridden.
mock.module("../../../../../persistence/conversation-crud.js", () => ({
  ...realConversationCrud,
  getMessages: () => messages.map((m, i) => ({ ...m, id: `m${i}` })),
}));

mock.module("../../../../../persistence/db-connection.js", () => ({
  getDb: () => testDb,
  getSqliteFrom: () => testSqlite,
}));

mock.module("../../v2/page-index.js", () => ({
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
      // A synthetic capability row — same shape the v2 page index appends for
      // skills/CLI commands. `initLanes` must route it through the capability
      // resolver, not an on-disk read.
      {
        slug: CAPABILITY_SLUG,
        id: 3,
        summary: "",
        edges: [],
        leaves: [],
        modifiedAt: 0,
      },
      // Extra real concept rows (modifiedAt > 0) a test can request to cross the
      // v3 full-profile page threshold; default 0 keeps the corpus sparse (lean).
      ...Array.from({ length: extraRealConceptPages }, (_, i) => ({
        slug: `concepts/seed-${i}`,
        id: 100 + i,
        summary: "",
        edges: [],
        leaves: [],
        modifiedAt: 1,
      })),
    ],
    bySlug: new Map(),
  }),
}));

// `pageContent` (live mode) reads the full page via `readPage`/`renderPageContent`.
mock.module("../../v2/page-store.js", () => ({
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

mock.module("../../../../../util/platform.js", () => ({
  ...realPlatform,
  getWorkspaceDir: () =>
    shadowMockActive
      ? "/tmp/shadow-test-workspace"
      : realPlatform.getWorkspaceDir(),
}));

// Capability stores: `renderCapabilityContent` (reached from `initLanes`' pageBody
// and from the live injector) resolves synthetic slugs through these. Spread the
// real module so the prefix predicates (`isSkillSlug`/`isCliCommandSlug`) stay
// intact; override only the content lookup so the capability slug resolves.
mock.module("../../v2/skill-store.js", () => ({
  ...realSkillStore,
  getSkillCapability: (idOrSlug: string) =>
    shadowMockActive
      ? idOrSlug === CAPABILITY_SLUG
        ? { id: "example", content: CAPABILITY_CONTENT }
        : null
      : realSkillStore.getSkillCapability(idOrSlug),
}));

mock.module("../../v2/cli-command-store.js", () => ({
  ...realCliCommandStore,
  getCliCommandCapability: (idOrSlug: string) =>
    shadowMockActive
      ? null
      : realCliCommandStore.getCliCommandCapability(idOrSlug),
}));

mock.module("../sections.js", () => ({
  ...realSections,
  buildSectionIndex: async (
    ...args: Parameters<typeof realSections.buildSectionIndex>
  ) => {
    if (!shadowMockActive) return realSections.buildSectionIndex(...args);
    sectionBuilds++;
    // Capture the `pageBody` resolver so a test can exercise the capability
    // branch directly. Returning the FAKE index keeps the other tests cheap.
    capturedPageBody = args[1];
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

mock.module("../learned-edges.js", () => ({
  ...realLearnedEdges,
  computeLearnedEdgeGraph: (
    ...args: Parameters<typeof realLearnedEdges.computeLearnedEdgeGraph>
  ) => {
    if (!shadowMockActive)
      return realLearnedEdges.computeLearnedEdgeGraph(...args);
    learnedGraphBuilds++;
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
    if (ensureCollectionThrows) throw new Error("qdrant unavailable");
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
const {
  observeTurn,
  resetShadowLanesForTests,
  invalidateLanes,
  attributeSelections,
} = await import("../shadow-plugin.js");
const { memoryV3Injector, resetMemoryV3InjectorStateForTests } =
  await import("../injector.js");
const { MemoryV3RetrievalUnavailableError } = await import("../pool-select.js");

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
  memoryEnabled = true;
  learnedEdgesCap = 0;
  extraRealConceptPages = 0;
  selectorEnabledCfg = false;
  gateFlagEnabled = false;
  gateEnabledCfg = true;
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
  learnedGraphBuilds = 0;
  ensureCollectionCalls = 0;
  ensureCollectionThrows = false;
  capturedPageBody = null;
  coreSetSlugs = [];
  hotSetResult = [];
  hotSetOpts = null;
  testDb = makeDb();
  resetShadowLanesForTests();
  // The injector memoizes one orchestration per (conversation, turn); clear it
  // so tests reusing the same ids observe fresh orchestrations.
  resetMemoryV3InjectorStateForTests();
});

/** Invoke the memory-v3 injector's `produce()` for a turn and, when a block
 *  is produced, invoke its attachment-commit callback — simulating runtime
 *  assembly's user-tail commit point, where the everInjected-store write now
 *  happens. */
async function produce(conversationId: string, turnIndex: number) {
  const block = await memoryV3Injector.produce({
    requestId: "r1",
    conversationId,
    turnIndex,
    trust: {} as never,
  });
  const commit = block?.meta?.[MEMORY_V3_COMMIT_META_KEY];
  if (typeof commit === "function") (commit as () => void)();
  return block;
}

describe("memory-v3 engine", () => {
  test("global memory disabled → observation is skipped", async () => {
    memoryEnabled = false;

    await observeTurn("conv-1", 0);

    expect(orchestrateSpy).not.toHaveBeenCalled();
    expect(sectionBuilds).toBe(0);
    expect(readRows()).toHaveLength(0);
  });

  test("observeTurn runs orchestration and writes rows with per-lane sources", async () => {
    await observeTurn("conv-1", 2);

    expect(orchestrateSpy).toHaveBeenCalledTimes(1);
    const rows = readRows();
    // Each selection is attributed to the lane that pooled it
    // (`result.lanes`), not re-derived from section presence — so the
    // dense-only page-2 logs "dense", not "needle". The result is
    // current-turn selections only.
    expect(rows).toEqual([
      // page-1 was surfaced by the needle lane → "needle", pinned.
      { slug: "page-1", source: "needle", pinned: 1 },
      // page-2 was surfaced by the dense lane → "dense".
      { slug: "page-2", source: "dense", pinned: 0 },
      // page-3 was surfaced by the edge lane → "edge".
      { slug: "page-3", source: "edge", pinned: 0 },
      // page-4 was first surfaced by the reply-query pass → "reply".
      { slug: "page-4", source: "reply", pinned: 0 },
      // page-5 was first surfaced by the learned-edge pass → "learned".
      { slug: "page-5", source: "learned", pinned: 0 },
      // page-core / page-hot / page-fresh sit in the stable prefix →
      // "core" / "hot" / "fresh".
      { slug: "page-core", source: "core", pinned: 0 },
      { slug: "page-fresh", source: "fresh", pinned: 0 },
      { slug: "page-hot", source: "hot", pinned: 0 },
    ]);
  });

  test("the turn carries the tail of the previous assistant reply for the reply-query pass", async () => {
    messages = [
      {
        role: "user",
        content: JSON.stringify([{ type: "text", text: "first question" }]),
      },
      {
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "the thread continues from my last reply" },
        ]),
      },
      {
        role: "user",
        content: JSON.stringify([{ type: "text", text: "and now this" }]),
      },
    ];
    await observeTurn("conv-1", 1);

    const turn = (
      orchestrateSpy.mock.calls as unknown as unknown[][]
    )[0]![0] as MemoryRoutingTurn;
    expect(turn.currentMessage).toBe("and now this");
    expect(turn.previousAssistantMessage).toBe(
      "the thread continues from my last reply",
    );
  });

  test("a conversation-opening turn has no previous assistant message", async () => {
    await observeTurn("conv-1", 0);

    const turn = (
      orchestrateSpy.mock.calls as unknown as unknown[][]
    )[0]![0] as MemoryRoutingTurn;
    expect(turn.previousAssistantMessage).toBeUndefined();
  });

  test("a selection of a core page a finder also hit attributes to core (pool position wins)", () => {
    const rows = attributeSelections({
      selections: [{ slug: "page-core", pinned: false }],
      matchedSections: new Map(),
      lanes: {
        core: ["page-core"],
        hot: [],
        fresh: [],
        // The needle also hit the core page this turn — the row still logs
        // "core" because that is where the candidate lived in the pool.
        finder: [{ slug: "page-core", descriptor: "", lane: "needle" }],
      },
    });
    expect(rows).toEqual([
      {
        slug: "page-core",
        source: "core",
        pinned: 0,
        sectionOrdinal: null,
        sectionTitle: null,
      },
    ]);
  });

  test("the turn passed to orchestrate carries the latest user message", async () => {
    await observeTurn("conv-1", 0);
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
    await observeTurn("conv-1", 0);
    const deps = (
      orchestrateSpy.mock.calls as unknown as unknown[][]
    )[0]![1] as {
      sectionIndex?: unknown;
      needle?: unknown;
      edgeGraph?: unknown;
      coreSlugs?: unknown;
      hotSlugs?: unknown;
    };
    expect(deps.sectionIndex).toBeDefined();
    expect(deps.needle).toBeDefined();
    expect(deps.edgeGraph).toBeDefined();
    expect(deps.coreSlugs).toEqual([]);
    expect(deps.hotSlugs).toEqual([]);
  });

  test("learned-edge graph init is skipped when the configured cap is zero", async () => {
    await observeTurn("conv-1", 0);

    const deps = (
      orchestrateSpy.mock.calls as unknown as unknown[][]
    )[0]![1] as {
      learnedGraph?: unknown;
      learnedCap?: number;
    };
    expect(learnedGraphBuilds).toBe(0);
    expect(deps.learnedGraph).toBeUndefined();
    expect(deps.learnedCap).toBe(0);
  });

  test("learned-edge graph init runs when the configured cap is positive", async () => {
    learnedEdgesCap = 6;
    // The learned lane lives in the full profile, which a sparse corpus never
    // reaches — seed enough real concept pages to cross the page threshold.
    extraRealConceptPages = MEMORY_V3_FULL_PROFILE_MIN_PAGES;

    await observeTurn("conv-1", 0);

    const deps = (
      orchestrateSpy.mock.calls as unknown as unknown[][]
    )[0]![1] as {
      learnedGraph?: unknown;
      learnedCap?: number;
    };
    expect(learnedGraphBuilds).toBe(1);
    expect(deps.learnedGraph).toBeDefined();
    expect(deps.learnedCap).toBe(6);
  });

  test("re-resolves per-turn tuning from current config without a lane rebuild", async () => {
    // Established corpus so the configured knobs (not the lean profile) apply.
    extraRealConceptPages = MEMORY_V3_FULL_PROFILE_MIN_PAGES;
    selectorEnabledCfg = false;
    await observeTurn("conv-1", 0);
    const firstDeps = (
      orchestrateSpy.mock.calls as unknown as unknown[][]
    )[0]![1] as { selectorEnabled?: boolean };
    expect(firstDeps.selectorEnabled).toBe(false);

    // Edit config mid-conversation; the lanes are NOT invalidated.
    selectorEnabledCfg = true;
    await observeTurn("conv-1", 1);
    const secondDeps = (
      orchestrateSpy.mock.calls as unknown as unknown[][]
    )[1]![1] as { selectorEnabled?: boolean };
    expect(secondDeps.selectorEnabled).toBe(true);
  });

  test("flag on → threads the gate tuning plus enabled:true into orchestrate", async () => {
    gateFlagEnabled = true;
    await observeTurn("conv-1", 0);

    const deps = (
      orchestrateSpy.mock.calls as unknown as unknown[][]
    )[0]![1] as { gateConfig?: unknown };
    // The spread is the live gate config: the `memory.v3.gate` tuning with the
    // flag-derived `enabled` folded in.
    expect(deps.gateConfig).toEqual({ ...GATE_DEFAULTS, enabled: true });
  });

  test("flag off (default) → gate config threads inert (enabled:false, schema-default tuning)", async () => {
    // gateFlagEnabled defaults to false in beforeEach.
    await observeTurn("conv-1", 0);

    const deps = (
      orchestrateSpy.mock.calls as unknown as unknown[][]
    )[0]![1] as { gateConfig?: { enabled?: boolean } };
    // Flag off → the gate is wired in but inert, and the tuning fields are the
    // schema defaults the config carries.
    expect(deps.gateConfig?.enabled).toBe(false);
    expect(deps.gateConfig).toEqual({ ...GATE_DEFAULTS, enabled: false });
  });

  test("flag on + gate.enabled:false config kill-switch → gate threads inert", async () => {
    gateFlagEnabled = true;
    gateEnabledCfg = false;
    await observeTurn("conv-1", 0);

    const deps = (
      orchestrateSpy.mock.calls as unknown as unknown[][]
    )[0]![1] as { gateConfig?: unknown };
    // The config kill-switch wins over the flag: the effective `enabled` is
    // false, so selection always runs.
    expect(deps.gateConfig).toEqual({ ...GATE_DEFAULTS, enabled: false });
  });

  test("initLanes filters core to existing pages and excludes core from the hot set", async () => {
    // The core file lists a live page and a dangling slug; the hot set returns
    // a live page and a deleted one (selection rows can outlive their pages).
    coreSetSlugs = ["page-1", "missing-page"];
    hotSetResult = [
      { slug: "page-2", score: 2 },
      { slug: "gone-page", score: 1 },
    ];
    await observeTurn("conv-1", 0);

    const deps = (
      orchestrateSpy.mock.calls as unknown as unknown[][]
    )[0]![1] as { coreSlugs: string[]; hotSlugs: string[] };
    // Dangling core entries and deleted hot pages never reach the pool.
    expect(deps.coreSlugs).toEqual(["page-1"]);
    expect(deps.hotSlugs).toEqual(["page-2"]);
    // The hot set was computed with the (filtered) core excluded and the
    // configured k / half-life (14 days, in ms).
    expect(hotSetOpts?.excludeSlugs).toEqual(new Set(["page-1"]));
    expect(hotSetOpts?.k).toBe(8);
    expect(hotSetOpts?.halfLifeMs).toBe(14 * 24 * 60 * 60 * 1000);
  });

  test("live off → produce returns null, no orchestrate, no writes", async () => {
    liveEnabled = false;
    const block = await produce("conv-1", 0);
    expect(block).toBeNull();
    expect(orchestrateSpy).not.toHaveBeenCalled();
    expect(readRows()).toHaveLength(0);
  });

  test("live on → produce returns the net-new CARD block and logs", async () => {
    liveEnabled = true;
    const block = await produce("conv-1", 0);
    expect(block).not.toBeNull();
    expect(block!.placement).toBe("after-memory-prefix");
    expect(block!.text.startsWith("<memory>\n")).toBe(true);
    expect(block!.text.endsWith("\n</memory>")).toBe(true);
    // Turn 1: every selection is net-new and renders as a compact card —
    // the page header plus the page's head section (the fixture body has no
    // `## ` headings, so the whole body is the head and no TOC line renders).
    for (const slug of ["page-core", "page-hot", "page-1", "page-2"]) {
      expect(block!.text).toContain(
        `# memory/concepts/${slug}.md\nbody for ${slug}`,
      );
    }
    // Selections are still logged in live mode.
    expect(readRows().length).toBeGreaterThan(0);
  });

  test("live on → a later turn re-selecting the same pages renders an EMPTY block (net-new dedup)", async () => {
    liveEnabled = true;
    const first = await produce("conv-1", 0);
    expect(first!.text.length).toBeGreaterThan(0);
    // Same orchestrate fixture on the next turn → zero net-new cards. The
    // block is still produced (its presence keys v2 suppression downstream).
    const repeat = await produce("conv-1", 1);
    expect(repeat).not.toBeNull();
    expect(repeat!.text).toBe("");
  });

  test("live on but empty selection → produce returns null", async () => {
    liveEnabled = true;
    orchestrateSpy.mockImplementationOnce(async () => ({
      selections: [],
      matchedSections: new Map(),
      lanes: { core: [], hot: [], fresh: [], finder: [] },
    }));
    const block = await produce("conv-1", 0);
    expect(block).toBeNull();
    expect(orchestrateSpy).toHaveBeenCalledTimes(1);
    expect(readRows()).toHaveLength(0);
  });

  test("lazy-init runs the lane builders only once across turns", async () => {
    await observeTurn("conv-1", 0);
    await observeTurn("conv-1", 1);
    await observeTurn("conv-1", 2);
    expect(sectionBuilds).toBe(1);
    expect(needleBuilds).toBe(1);
    expect(edgeBuilds).toBe(1);
    expect(ensureCollectionCalls).toBe(1);
    expect(orchestrateSpy).toHaveBeenCalledTimes(3);
  });

  test("a Qdrant section-collection failure does not disable the in-memory lanes", async () => {
    ensureCollectionThrows = true;
    // initLanes still builds the needle + edge lanes and orchestrate runs — a
    // Qdrant outage degrades only the dense lane, it does not take down all of v3
    // (and does not poison the memoized lanes by rejecting init).
    await observeTurn("conv-1", 0);
    expect(needleBuilds).toBe(1);
    expect(edgeBuilds).toBe(1);
    expect(ensureCollectionCalls).toBe(1);
    expect(orchestrateSpy).toHaveBeenCalledTimes(1);
  });

  test("invalidateLanes forces a one-time rebuild on the next turn", async () => {
    await observeTurn("conv-1", 0);
    await observeTurn("conv-1", 1);
    expect(sectionBuilds).toBe(1);
    expect(needleBuilds).toBe(1);

    invalidateLanes();

    await observeTurn("conv-1", 2);
    expect(sectionBuilds).toBe(2);
    expect(needleBuilds).toBe(2);
    expect(edgeBuilds).toBe(2);

    // ...and the rebuild is memoized again — no further builds until the next
    // invalidation.
    await observeTurn("conv-1", 3);
    expect(sectionBuilds).toBe(2);
    expect(needleBuilds).toBe(2);
  });

  test("resetShadowLanesForTests invalidates like invalidateLanes", async () => {
    await observeTurn("conv-1", 0);
    expect(sectionBuilds).toBe(1);

    resetShadowLanesForTests();

    await observeTurn("conv-1", 1);
    expect(sectionBuilds).toBe(2);
  });

  test("concurrent first turns after invalidation share a single build", async () => {
    await observeTurn("conv-1", 0);
    expect(sectionBuilds).toBe(1);

    invalidateLanes();

    await Promise.all([observeTurn("conv-1", 1), observeTurn("conv-1", 2)]);
    expect(sectionBuilds).toBe(2);
    expect(needleBuilds).toBe(2);
  });

  test("no user message → no orchestrate, no writes", async () => {
    messages = [
      {
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "hi" }]),
      },
    ];
    await observeTurn("conv-1", 0);
    expect(orchestrateSpy).not.toHaveBeenCalled();
    expect(readRows()).toHaveLength(0);
  });

  describe("initLanes feeds synthetic capability pages into the section index", () => {
    test("the pageBody resolver returns capability content for a synthetic slug and disk body otherwise", async () => {
      await observeTurn("conv-1", 0);

      // `initLanes` ran the real pageBody-building closure and handed it to
      // `buildSectionIndex`; the stub captured it.
      expect(capturedPageBody).not.toBeNull();
      const pageBody = capturedPageBody!;

      // A capability slug resolves to its rendered capability content (NOT an
      // on-disk read, which would miss), so the needle can rank it.
      const capBody = await pageBody(CAPABILITY_SLUG);
      expect(capBody).toContain("kumquat");
      // On-disk slugs still resolve to their page body.
      expect(await pageBody("page-1")).toBe("body for page-1");
    });

    test("a synthetic slug's capability content yields a section the needle ranks", async () => {
      await observeTurn("conv-1", 0);
      const pageBody = capturedPageBody!;

      // Feed the captured resolver through the REAL section builder + needle:
      // the capability slug yields ≥1 section and is ranked on a term from its
      // capability content — the path that makes synthetic pages lane-rankable.
      const index = await realSections.buildSectionIndex(
        [CAPABILITY_SLUG],
        pageBody,
      );
      expect(index.byArticle.get(CAPABILITY_SLUG)?.length ?? 0).toBeGreaterThan(
        0,
      );

      const needle = realSectionNeedle.buildSectionNeedle(index);
      const hits = needle.query("kumquat", 5);
      expect(hits.map((h) => h.article)).toContain(CAPABILITY_SLUG);
    });
  });
});

describe("memory-v3 infrastructure-failure handling", () => {
  const throwInfra = () =>
    orchestrateSpy.mockImplementationOnce(async () => {
      throw new MemoryV3RetrievalUnavailableError(
        "selector provider unavailable",
      );
    });

  test("LIVE injector logs and degrades to no v3 block on an infra failure", async () => {
    liveEnabled = true;
    throwInfra();

    expect(await produce("conv-infra-live", 0)).toBeNull();
  });

  test("observeTurn rethrows an infra failure so the injector can degrade distinctly", async () => {
    throwInfra();

    await expect(observeTurn("conv-infra-obs", 0)).rejects.toBeInstanceOf(
      MemoryV3RetrievalUnavailableError,
    );
  });

  test("LIVE injector stays NON-fatal on a non-infra error (degrades to no v3 block)", async () => {
    liveEnabled = true;
    orchestrateSpy.mockImplementationOnce(async () => {
      throw new Error("some unexpected non-infra bug");
    });

    expect(await produce("conv-nonfatal-live", 0)).toBeNull();
  });
});
