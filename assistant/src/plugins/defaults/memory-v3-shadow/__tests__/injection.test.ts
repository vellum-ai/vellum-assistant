/**
 * Tests for the memory-v3 injection layer (`injector.ts`): frozen net-new
 * cards + ephemeral spotlight.
 *
 *   - net-new dedup: a turn re-selecting already-injected pages renders zero
 *     new cards (empty-text block — still produced, so v2 suppression holds);
 *   - fork dedup: a conversation whose everInjected record was seeded from
 *     inherited blocks does not re-render those slugs;
 *   - prune round-trip: a pruned slug that is re-selected re-injects;
 *   - shadow mode: attaches nothing and records nothing, but logs the
 *     would-inject set;
 *   - spotlight: current-window entries only, re-rendered (never accumulated),
 *     bounded by `n × (windowTurns + 1)`, live-only, absent from the
 *     persistent card layer.
 *
 * Orchestration is stubbed at the `observeTurn` seam (the injectors' shared
 * input); the everInjected store runs REAL against an in-memory SQLite DB so
 * the dedup contract is exercised end-to-end. `mock.module` is process-global,
 * so every stub delegates to the real implementation unless this file's tests
 * are running (`injectionMockActive`) — mirrors the sibling test files.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateAddMemoryV3EverInjected } from "../../../../memory/migrations/275-add-memory-v3-ever-injected.js";
import * as schema from "../../../../memory/schema.js";
import type { OrchestrateResult } from "../orchestrate.js";
import type { Section, Slug } from "../types.js";

const realConfigLoader = { ...(await import("../../../../config/loader.js")) };
const realFlags = {
  ...(await import("../../../../config/assistant-feature-flags.js")),
};
const realDbConnection = {
  ...(await import("../../../../memory/db-connection.js")),
};
const realPageContent = { ...(await import("../page-content.js")) };
const realShadowPlugin = { ...(await import("../shadow-plugin.js")) };

let injectionMockActive = false;

// ─── mutable test state ──────────────────────────────────────────────────────

let liveEnabled = false;
let shadowEnabled = false;
let spotlightConfig = { n: 6, windowTurns: 2 };
/** Canned orchestrate result per turnIndex; `null` simulates a failed turn. */
let turnResults = new Map<number, OrchestrateResult | null>();
const observeTurnSpy = mock(
  async (
    _conversationId: string,
    turnIndex: number,
  ): Promise<OrchestrateResult | null> => turnResults.get(turnIndex) ?? null,
);

const logCalls: Array<{ data: unknown; msg: string }> = [];
mock.module("../../../../util/logger.js", () => ({
  getLogger: () => ({
    info: (data: unknown, msg: string) => logCalls.push({ data, msg }),
    warn: (data: unknown, msg: string) => logCalls.push({ data, msg }),
    error: () => {},
    debug: () => {},
  }),
}));

let testSqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  const db = drizzle(testSqlite, { schema });
  migrateAddMemoryV3EverInjected(db);
  return db;
}

mock.module("../../../../memory/db-connection.js", () => ({
  ...realDbConnection,
  getDb: () => (injectionMockActive ? testDb : realDbConnection.getDb()),
  getSqliteFrom: (db: unknown) =>
    injectionMockActive
      ? testSqlite
      : realDbConnection.getSqliteFrom(
          db as Parameters<typeof realDbConnection.getSqliteFrom>[0],
        ),
}));

mock.module("../../../../config/loader.js", () => ({
  ...realConfigLoader,
  getConfig: () =>
    injectionMockActive
      ? { memory: { v3: { spotlight: spotlightConfig } } }
      : realConfigLoader.getConfig(),
}));

mock.module("../../../../config/assistant-feature-flags.js", () => ({
  ...realFlags,
  isAssistantFeatureFlagEnabled: (
    key: string,
    config: Parameters<typeof realFlags.isAssistantFeatureFlagEnabled>[1],
  ) => {
    if (!injectionMockActive) {
      return realFlags.isAssistantFeatureFlagEnabled(
        key as Parameters<typeof realFlags.isAssistantFeatureFlagEnabled>[0],
        config,
      );
    }
    return key === "memory-v3-live"
      ? liveEnabled
      : key === "memory-v3-shadow"
        ? shadowEnabled
        : false;
  },
}));

mock.module("../page-content.js", () => ({
  ...realPageContent,
  renderV3CardContent: async (slug: Slug) =>
    injectionMockActive
      ? slug === "missing-page"
        ? ""
        : `# memory/concepts/${slug}.md\ncard body for ${slug}`
      : realPageContent.renderV3CardContent(slug),
}));

mock.module("../shadow-plugin.js", () => ({
  ...realShadowPlugin,
  observeTurn: (conversationId: string, turnIndex: number) =>
    injectionMockActive
      ? observeTurnSpy(conversationId, turnIndex)
      : realShadowPlugin.observeTurn(conversationId, turnIndex),
}));

const {
  memoryV3Injector,
  memoryV3SpotlightInjector,
  resetMemoryV3InjectorStateForTests,
} = await import("../injector.js");
const { getActiveSlugs, getInjected, markPruned, recordInjected } =
  await import("../ever-injected-store.js");
const { V3_CARDS_INJECTION_HEADER } = await import("../render-injection.js");

// ─── helpers ────────────────────────────────────────────────────────────────

function section(slug: Slug, title: string, text: string): Section {
  return { article: slug, title, text, ordinal: 1 };
}

/** An orchestrate result selecting `slugs`, with optional finder-matched
 *  sections (slug → section) feeding the spotlight. */
function result(
  slugs: Slug[],
  matched: Array<[Slug, Section]> = [],
): OrchestrateResult {
  return {
    selections: slugs.map((slug) => ({ slug, pinned: false })),
    matchedSections: new Map(matched),
    lanes: {
      core: [],
      hot: [],
      finder: matched.map(([slug]) => ({
        slug,
        descriptor: "",
        lane: "needle" as const,
      })),
    },
  };
}

function produceCards(conversationId: string, turnIndex: number) {
  return memoryV3Injector.produce({
    requestId: "req-1",
    conversationId,
    turnIndex,
    trust: { sourceChannel: "vellum", trustClass: "guardian" },
  });
}

function produceSpotlight(conversationId: string, turnIndex: number) {
  return memoryV3SpotlightInjector.produce({
    requestId: "req-1",
    conversationId,
    turnIndex,
    trust: { sourceChannel: "vellum", trustClass: "guardian" },
  });
}

beforeEach(() => {
  injectionMockActive = true;
  liveEnabled = false;
  shadowEnabled = false;
  spotlightConfig = { n: 6, windowTurns: 2 };
  turnResults = new Map();
  observeTurnSpy.mockClear();
  logCalls.length = 0;
  testDb = makeDb();
  resetMemoryV3InjectorStateForTests();
});

afterAll(() => {
  injectionMockActive = false;
});

// ─── frozen net-new cards ───────────────────────────────────────────────────

describe("memoryV3Injector — frozen net-new cards", () => {
  test("turn 1 renders cards; turn 2 re-selecting the same pages renders ZERO new cards", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a", "page-b"]));
    turnResults.set(1, result(["page-a", "page-b"]));

    const t1 = await produceCards("conv-1", 0);
    expect(t1).not.toBeNull();
    expect(t1!.placement).toBe("after-memory-prefix");
    expect(t1!.text.startsWith("<memory>\n")).toBe(true);
    expect(t1!.text).toContain(V3_CARDS_INJECTION_HEADER);
    expect(t1!.text).toContain("# memory/concepts/page-a.md");
    expect(t1!.text).toContain("# memory/concepts/page-b.md");
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["page-a", "page-b"]));
    // Recorded bytes match the rendered card sizes (non-zero).
    for (const entry of getInjected("conv-1").values()) {
      expect(entry.bytes).toBeGreaterThan(0);
      expect(entry.prunedAt).toBeNull();
    }

    // All-repeat turn: the block is still PRODUCED (its presence keys v2
    // suppression) but carries no text — no new persistent bytes.
    const t2 = await produceCards("conv-1", 1);
    expect(t2).not.toBeNull();
    expect(t2!.text).toBe("");
  });

  test("a partially-new turn renders only the net-new cards", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    turnResults.set(1, result(["page-a", "page-c"]));

    await produceCards("conv-1", 0);
    const t2 = await produceCards("conv-1", 1);
    expect(t2!.text).toContain("# memory/concepts/page-c.md");
    expect(t2!.text).not.toContain("# memory/concepts/page-a.md");
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["page-a", "page-c"]));
  });

  test("fork-seeded dedup record suppresses re-rendering inherited slugs", async () => {
    liveEnabled = true;
    // PR 4's fork hooks seed the child's record from inherited metadata
    // blocks; from the injector's perspective that is just pre-existing rows.
    recordInjected("conv-fork", [{ slug: "page-a", bytes: 0 }]);
    turnResults.set(0, result(["page-a", "page-b"]));

    const block = await produceCards("conv-fork", 0);
    expect(block!.text).toContain("# memory/concepts/page-b.md");
    expect(block!.text).not.toContain("# memory/concepts/page-a.md");
  });

  test("a pruned slug that is re-selected re-injects as a fresh card", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    turnResults.set(1, result(["page-a"]));

    await produceCards("conv-1", 0);
    markPruned("conv-1", ["page-a"], Date.now());
    expect(getActiveSlugs("conv-1")).toEqual(new Set());

    const t2 = await produceCards("conv-1", 1);
    expect(t2!.text).toContain("# memory/concepts/page-a.md");
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["page-a"]));
  });

  test("slugs whose card renders empty are neither attached nor recorded", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["missing-page", "page-a"]));

    const block = await produceCards("conv-1", 0);
    expect(block!.text).toContain("# memory/concepts/page-a.md");
    expect(block!.text).not.toContain("missing-page");
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["page-a"]));
  });

  test("empty selection → null (fallback to v2), nothing recorded", async () => {
    liveEnabled = true;
    turnResults.set(0, result([]));
    expect(await produceCards("conv-1", 0)).toBeNull();
    expect(getActiveSlugs("conv-1")).toEqual(new Set());
  });

  test("shadow mode (live off) attaches nothing, records nothing, logs the would-inject set", async () => {
    shadowEnabled = true;
    turnResults.set(
      0,
      result(
        ["page-a"],
        [["page-a", section("page-a", "Heading", "section text")]],
      ),
    );

    expect(await produceCards("conv-1", 0)).toBeNull();
    expect(await produceSpotlight("conv-1", 0)).toBeNull();
    expect(getActiveSlugs("conv-1")).toEqual(new Set());
    const shadowLog = logCalls.find((c) =>
      c.msg.includes("memory-v3 shadow: would inject"),
    );
    expect(shadowLog).toBeDefined();
    const data = shadowLog!.data as {
      netNew: Array<{ slug: string; bytes: number }>;
      spotlightRefs: string[];
    };
    expect(data.netNew.map((e) => e.slug)).toEqual(["page-a"]);
    expect(data.spotlightRefs).toEqual(["page-a§Heading"]);
  });

  test("the persistent card block never contains the spotlight wrapper", async () => {
    liveEnabled = true;
    turnResults.set(
      0,
      result(
        ["page-a"],
        [["page-a", section("page-a", "Heading", "section text")]],
      ),
    );
    const block = await produceCards("conv-1", 0);
    expect(block!.text).not.toContain("<memory_spotlight>");
  });

  test("both injectors share ONE orchestration per turn (memoized)", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    await produceCards("conv-1", 0);
    await produceSpotlight("conv-1", 0);
    expect(observeTurnSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── ephemeral spotlight ────────────────────────────────────────────────────

describe("memoryV3SpotlightInjector — ephemeral section spotlight", () => {
  const sectionA = section("page-a", "Alpha", "alpha section text");
  const sectionB = section("page-b", "Beta", "beta section text");
  const sectionC = section("page-c", "Gamma", "gamma section text");

  test("renders selected finder hits' matched sections at the user tail", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a", "page-b"], [["page-a", sectionA]]));

    const block = await produceSpotlight("conv-1", 0);
    expect(block).not.toBeNull();
    expect(block!.placement).toBe("append-user-tail");
    expect(block!.text.startsWith("<memory_spotlight>\n")).toBe(true);
    expect(block!.text.endsWith("\n</memory_spotlight>")).toBe(true);
    expect(block!.text).toContain(
      "## memory/concepts/page-a.md § Alpha\nalpha section text",
    );
  });

  test("unselected finder hits do not spotlight; top-n bound applies", async () => {
    liveEnabled = true;
    spotlightConfig = { n: 1, windowTurns: 0 };
    turnResults.set(
      0,
      result(
        ["page-a", "page-b"],
        [
          ["page-c", sectionC], // finder hit, NOT selected
          ["page-a", sectionA],
          ["page-b", sectionB], // selected but over the n=1 cut
        ],
      ),
    );
    const block = await produceSpotlight("conv-1", 0);
    expect(block!.text).toContain("page-a.md § Alpha");
    expect(block!.text).not.toContain("page-b.md");
    expect(block!.text).not.toContain("page-c.md");
  });

  test("carries the previous windowTurns turns' entries, ages older ones out, never accumulates", async () => {
    liveEnabled = true;
    spotlightConfig = { n: 6, windowTurns: 1 };
    turnResults.set(0, result(["page-a"], [["page-a", sectionA]]));
    turnResults.set(1, result(["page-b"], [["page-b", sectionB]]));
    turnResults.set(2, result(["page-c"], [["page-c", sectionC]]));

    const t1 = await produceSpotlight("conv-1", 0);
    expect(t1!.text).toContain("Alpha");

    // Turn 1: current (Beta) + previous turn (Alpha).
    const t2 = await produceSpotlight("conv-1", 1);
    expect(t2!.text).toContain("Beta");
    expect(t2!.text).toContain("Alpha");

    // Turn 2: current (Gamma) + turn 1 (Beta); turn 0 (Alpha) aged out.
    const t3 = await produceSpotlight("conv-1", 2);
    expect(t3!.text).toContain("Gamma");
    expect(t3!.text).toContain("Beta");
    expect(t3!.text).not.toContain("Alpha");
  });

  test("re-producing the SAME turn replaces its window entry (no duplication)", async () => {
    liveEnabled = true;
    spotlightConfig = { n: 6, windowTurns: 2 };
    turnResults.set(0, result(["page-a"], [["page-a", sectionA]]));

    await produceSpotlight("conv-1", 0);
    const again = await produceSpotlight("conv-1", 0);
    const occurrences = again!.text.split("page-a.md § Alpha").length - 1;
    expect(occurrences).toBe(1);
  });

  test("window is bounded by n × (windowTurns + 1) entries", async () => {
    liveEnabled = true;
    spotlightConfig = { n: 2, windowTurns: 1 };
    const sections = (turn: number): Array<[Slug, Section]> =>
      ["w", "x", "y", "z"].map((s) => {
        const slug = `page-${s}${turn}`;
        return [slug, section(slug, `T${turn}${s}`, "text")] as [Slug, Section];
      });
    turnResults.set(
      0,
      result(
        sections(0).map(([s]) => s),
        sections(0),
      ),
    );
    turnResults.set(
      1,
      result(
        sections(1).map(([s]) => s),
        sections(1),
      ),
    );

    await produceSpotlight("conv-1", 0);
    const block = await produceSpotlight("conv-1", 1);
    const entryCount = (block!.text.match(/^## memory\/concepts\//gm) ?? [])
      .length;
    expect(entryCount).toBeLessThanOrEqual(2 * (1 + 1));
  });

  test("no matched sections in the window → no block", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    expect(await produceSpotlight("conv-1", 0)).toBeNull();
  });

  test("live off → null even when shadow is on", async () => {
    shadowEnabled = true;
    turnResults.set(0, result(["page-a"], [["page-a", sectionA]]));
    expect(await produceSpotlight("conv-1", 0)).toBeNull();
  });
});
