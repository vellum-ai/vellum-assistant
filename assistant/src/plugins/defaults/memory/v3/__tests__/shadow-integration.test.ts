/**
 * End-to-end integration test for the memory-v3 section-lane pipeline.
 *
 * SCOPE / ALTITUDE. A full daemon-assembly run (plugin registry → config read →
 * runtime assembly → provider call → DB write) is too heavy and too
 * mock-fragile for a unit test. Instead this composes the REAL engine units
 * with a mocked select provider, a stubbed dense lane, an in-memory selections
 * DB, and synthetic fixtures, driving them over a MULTI-TURN sequence:
 *
 *   orchestrate (cache-ordered pool: core + hot stable prefix, then
 *     needle ∪ dense ∪ edge finder candidates → ONE selectPool call)
 *       → attribute selections to lane sources (the plugin's REAL
 *         `attributeSelections`, reading `result.lanes`)
 *       → write to `memory_v3_selections` (the plugin's REAL
 *         `writeSelections`)
 *       → summarizeSelections (the offline A/B readout)
 *
 * This is exactly the selection contract the engine records each turn: the
 * candidate pool is the cache-ordered union of the lanes — synthetic capability
 * pages are indexed like any other page, so they enter through the needle lane
 * rather than being always-added — a SINGLE select runs per turn, the result is
 * this turn's selections only, and each selection is logged tagged with its
 * lane source. Selection logging runs on the live path
 * (`memory.v3.live`); injection is exercised in the injector tests.
 *
 * Slugs are generic placeholders (`page-a`, `topic-x`, `page-b`, …) — this is a
 * public repo.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message, Provider, ProviderResponse } from "@vellumai/plugin-api";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateAddMemoryV3Selections } from "../../../../../persistence/migrations/268-add-memory-v3-selections.js";
import { migrateMemoryV3SelectionsMessageIdAndSections } from "../../../../../persistence/migrations/283-memory-v3-selections-message-id-and-sections.js";
import * as schema from "../../../../../persistence/schema/index.js";
import type { PageIndexEntry } from "../../v2/page-index.js";
import { renderCard } from "../card.js";
import type { EdgeGraph } from "../edge.js";
import { buildEdgeGraph } from "../edge.js";
import type { OrchestrateResult } from "../orchestrate.js";
import { buildSectionNeedle } from "../section-needle.js";
import { buildSectionIndex } from "../sections.js";
import type { MemoryRoutingTurn, SectionIndex, Slug } from "../types.js";

// ---------------------------------------------------------------------------
// Module stubs installed BEFORE the orchestrator / store imports so they
// observe them at load time. Every stub DELEGATES to the real implementation
// unless this file's tests are running, so the process-global `mock.module`
// cannot leak fake behavior into sibling test files.
// ---------------------------------------------------------------------------

let mockActive = false;

let providerStub: Provider | null = null;

// The select pool imports `getConfiguredProvider` from `@vellumai/plugin-api`.
// Spread the real contract module so unrelated exports stay present; override
// only `getConfiguredProvider`, and only while this file is active so the stub
// cannot leak into sibling tests.
const realPluginApi = await import("@vellumai/plugin-api");
mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  getConfiguredProvider: async (
    ...args: Parameters<typeof realPluginApi.getConfiguredProvider>
  ) =>
    mockActive ? providerStub : realPluginApi.getConfiguredProvider(...args),
}));

mock.module("../../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => (prop === "child" ? () => ({}) : () => {}),
    }),
}));

// The dense lane is stubbed to a controllable hit list; it DELEGATES to the
// real `denseLane` unless this file is running so dense.test.ts still exercises
// the real lane.
const realDense = { ...(await import("../dense.js")) };
let denseHits: Array<{ article: Slug; section: number }> = [];
mock.module("../dense.js", () => ({
  ...realDense,
  denseLane: async (...args: Parameters<typeof realDense.denseLane>) =>
    mockActive ? denseHits : realDense.denseLane(...args),
  // Orchestrate calls the SCORED variant; intercept it under the same
  // `mockActive` guard (the gate is disabled in these tests, so the score is
  // arbitrary — a constant 1) so the swap can't leak through to real Qdrant.
  denseLaneScored: async (
    ...args: Parameters<typeof realDense.denseLaneScored>
  ) =>
    mockActive
      ? denseHits.map((h) => ({ ...h, score: 1 }))
      : realDense.denseLaneScored(...args),
}));

// In-memory selections DB. `summarizeSelections` reads via getDb/getSqliteFrom;
// the writer below writes through the same handles.
const realDb = {
  ...(await import("../../../../../persistence/db-connection.js")),
};
let testSqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  testSqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(testSqlite, { schema });
  migrateAddMemoryV3Selections(db);
  migrateMemoryV3SelectionsMessageIdAndSections(db);
  return db;
}
mock.module("../../../../../persistence/db-connection.js", () => ({
  ...realDb,
  getDb: () => (mockActive ? testDb : realDb.getDb()),
  getSqliteFrom: (db: unknown) =>
    mockActive
      ? testSqlite
      : realDb.getSqliteFrom(db as Parameters<typeof realDb.getSqliteFrom>[0]),
}));

const { orchestrate } = await import("../orchestrate.js");
const { summarizeSelections } = await import("../selection-log-store.js");
// The REAL attribution + writer from the shadow plugin, imported AFTER the
// db-connection mock so `writeSelections` binds to the in-memory test DB. Using
// the production code (rather than a local copy) means this test exercises the
// real `result.lanes` attribution — the only thing that can emit "dense".
const { attributeSelections, writeSelections } =
  await import("../shadow-plugin.js");

// ---------------------------------------------------------------------------
// Fixtures: a tiny corpus. `page-a` carries a curated link to `topic-x` so the
// edge lane surfaces it; each page has a distinctive section term so a query
// selects exactly that page via the needle.
// ---------------------------------------------------------------------------

const PAGES: Record<Slug, string> = {
  "page-a": "lead a\n## Body\napple content for page a",
  "page-b": "lead b\n## Body\nbanana content for page b",
  "topic-x": "lead x\n## Body\ncherry content for topic x",
};

const RAW: Record<Slug, string> = {
  "page-a": `---\nlinks:\n  - "topic-x — the curated edge from a to x"\n---\n${PAGES["page-a"]}`,
  "page-b": `---\nedges: []\n---\n${PAGES["page-b"]}`,
  "topic-x": `---\nedges: []\n---\n${PAGES["topic-x"]}`,
};

const SLUGS = Object.keys(PAGES);

// A synthetic capability page (skill). Its content carries a distinctive term
// ("durian") so the real needle ranks it — synthetic pages are indexed and
// lane-ranked like any other page, not always-added to the pool.
const CAPABILITY_SLUG = "skills/example";
const CAPABILITY_CONTENT =
  "# Skill: example\ndurian content for the example skill";
const INDEX_SLUGS = [...SLUGS, CAPABILITY_SLUG];

/** Page-body resolver mirroring `initLanes`: capability slug → its rendered
 *  content, on-disk slug → its page body. */
function bodyOf(slug: Slug): string {
  return slug === CAPABILITY_SLUG ? CAPABILITY_CONTENT : PAGES[slug]!;
}

function makeEntries(): PageIndexEntry[] {
  return INDEX_SLUGS.map((slug, i) => ({
    id: i + 1,
    slug,
    summary: `summary of ${slug}`,
    edges: [],
    leaves: [],
    modifiedAt: 0,
  }));
}

async function buildLanes(): Promise<{
  sectionIndex: SectionIndex;
  needle: ReturnType<typeof buildSectionNeedle>;
  edgeGraph: EdgeGraph;
}> {
  const sectionIndex = await buildSectionIndex(INDEX_SLUGS, async (s) =>
    bodyOf(s),
  );
  const needle = buildSectionNeedle(sectionIndex);
  // The capability slug has no `links:` frontmatter, so the edge graph reads
  // through `RAW` for the on-disk pages and its raw content otherwise.
  const edgeGraph = await buildEdgeGraph(makeEntries(), async (s) =>
    s === CAPABILITY_SLUG ? CAPABILITY_CONTENT : RAW[s]!,
  );
  return { sectionIndex, needle, edgeGraph };
}

const config = {} as never;
const CONV = "conv-xyz";

function makeTurn(
  turnNumber: number,
  currentMessage: string,
): MemoryRoutingTurn {
  return {
    conversationId: CONV,
    turnNumber,
    currentMessage,
    recentContext: "prior context",
  };
}

function toolUseResponse(input: Record<string, unknown>): ProviderResponse {
  return {
    model: "stub-model",
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0 },
    content: [{ type: "tool_use", id: "tu-1", name: "select_pages", input }],
  };
}

/**
 * Parse the two-segment selector input back into the globally-numbered pool
 * slug list: stable-prefix cards (`<candidate_cards>`, identified by their
 * `[i] # memory/concepts/<slug>.md` header line) then finder lines
 * (`<candidates>`, `[i] slug — descriptor`).
 */
function candidateSlugs(messages: Message[]): Slug[] {
  const entries: Array<{ id: number; slug: string }> = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== "text") continue;
      const cards = /<candidate_cards>\n([\s\S]*?)\n<\/candidate_cards>/.exec(
        block.text,
      );
      if (cards) {
        for (const m of cards[1].matchAll(
          /^\[(\d+)\] # memory\/concepts\/(.+)\.md$/gm,
        )) {
          entries.push({ id: Number(m[1]), slug: m[2]! });
        }
      }
      const finder = /<candidates>\n([\s\S]*?)\n<\/candidates>/.exec(
        block.text,
      );
      if (finder) {
        for (const line of finder[1].split("\n")) {
          const m = /^\[(\d+)\] (?:\([^)]*\) )?(\S+)(?: — |$)/.exec(line);
          if (m) entries.push({ id: Number(m[1]), slug: m[2]! });
        }
      }
    }
  }
  return entries.sort((a, b) => a.id - b.id).map((e) => e.slug);
}

/**
 * Provider that selects the pooled candidates in `keep` (mapping each back to
 * its 1-based id), pinning those in `pin`. Records the rendered pool and counts
 * the select calls so the test can assert one select per turn over the union.
 */
let lastPool: Slug[] = [];
let selectCalls = 0;
function selectProvider(keep: Slug[], pin: Slug[] = []): Provider {
  return {
    name: "stub",
    sendMessage: async (messages) => {
      selectCalls++;
      const pool = candidateSlugs(messages);
      lastPool = pool;
      const ids: number[] = [];
      const pinned_ids: number[] = [];
      pool.forEach((slug, i) => {
        if (keep.includes(slug)) ids.push(i + 1);
        if (pin.includes(slug)) pinned_ids.push(i + 1);
      });
      return toolUseResponse({ ids, pinned_ids });
    },
  };
}

// ---------------------------------------------------------------------------
// Selection read-back. Attribution (`attributeSelections`) and the write
// (`writeSelections`) are the shadow plugin's REAL functions, imported above —
// so this test exercises the production `result.lanes` attribution rather
// than a local copy. The db-connection mock routes `writeSelections` at the
// in-memory test DB.
// ---------------------------------------------------------------------------

/** Read back every logged selection source for a turn, in row order. */
function loggedSources(turn: number): Array<{ slug: Slug; source: string }> {
  return testSqlite
    .query(
      `SELECT slug, source FROM memory_v3_selections
         WHERE conversation_id = ? AND turn = ? ORDER BY rowid`,
    )
    .all(CONV, turn) as Array<{ slug: Slug; source: string }>;
}

/** Drive one turn end-to-end: orchestrate → attribute → write. */
async function runTurn(
  turnNumber: number,
  query: string,
  keep: Slug[],
  pin: Slug[],
  deps: {
    lanes: Awaited<ReturnType<typeof buildLanes>>;
    core?: Slug[];
    hot?: Slug[];
    /** Dense-lane budget. Omitted → orchestrate's lean `DEFAULT_DENSE_K` (dense
     *  off by default); set positive to exercise the stubbed dense hits. */
    denseK?: number;
  },
): Promise<OrchestrateResult> {
  providerStub = selectProvider(keep, pin);
  const stableSlugs = [...(deps.core ?? []), ...(deps.hot ?? [])];
  const result = await orchestrate(makeTurn(turnNumber, query), {
    sectionIndex: deps.lanes.sectionIndex,
    needle: deps.lanes.needle,
    denseConfig: config,
    denseK: deps.denseK,
    edgeGraph: deps.lanes.edgeGraph,
    coreSlugs: deps.core ?? [],
    hotSlugs: deps.hot ?? [],
    freshSlugs: [],
    // Mirrors lane init: every stable-prefix slug gets a pre-rendered card.
    prefixCards: new Map(
      stableSlugs.map((slug) => [slug, renderCard(slug, RAW[slug] ?? "")]),
    ),
  });
  writeSelections(CONV, turnNumber, attributeSelections(result));
  return result;
}

beforeEach(() => {
  mockActive = true;
  providerStub = null;
  denseHits = [];
  lastPool = [];
  selectCalls = 0;
  testDb = makeDb();
});

afterAll(() => {
  mockActive = false;
});

// ---------------------------------------------------------------------------
// Pool composition: the candidate pool is the union of the lanes, and exactly
// one select runs per turn. Synthetic capability pages are indexed like any
// other page, so they enter through the needle lane when the query matches
// their content — not by always being appended.
// ---------------------------------------------------------------------------

describe("memory-v3 integration — candidate pool", () => {
  test("pool unions needle ∪ dense ∪ edge; one select per turn", async () => {
    const lanes = await buildLanes();
    // "apple" hits page-a (needle). Dense returns page-b (denseK enables the
    // lane — it is off by default). page-a links to topic-x (edge). "apple"
    // does NOT match the capability page, so it is not pooled this turn —
    // capability pages are lane-ranked, not always-added.
    denseHits = [{ article: "page-b", section: 0 }];
    await runTurn(1, "apple", [], [], { lanes, denseK: 100 });

    expect(selectCalls).toBe(1);
    expect(new Set(lastPool)).toEqual(new Set(["page-a", "page-b", "topic-x"]));
  });

  test("a synthetic capability page enters the pool via the needle lane", async () => {
    const lanes = await buildLanes();
    // "durian" is the distinctive term in the capability page's content, so the
    // real needle ranks it and folds it into the pool.
    await runTurn(1, "durian", [], [], { lanes });

    expect(selectCalls).toBe(1);
    expect(lastPool).toContain(CAPABILITY_SLUG);
  });
});

// ---------------------------------------------------------------------------
// Stable-prefix lanes: core and hot head the pool in cache order on EVERY
// turn regardless of the query, and their selections log with the core / hot
// source tags. Selections are current-turn only — nothing carries.
// ---------------------------------------------------------------------------

describe("memory-v3 integration — core + hot stable prefix", () => {
  test("core and hot head the pool every turn and log lane-correct sources", async () => {
    const lanes = await buildLanes();
    const prefix = { core: ["topic-x"], hot: ["page-b"] };

    // Turn 1: "apple" hits page-a (needle). The prefix precedes it in pool
    // order even though the query never matches topic-x / page-b.
    const t1 = await runTurn(1, "apple", ["topic-x", "page-a"], [], {
      lanes,
      ...prefix,
    });
    expect(lastPool).toEqual(["topic-x", "page-b", "page-a"]);
    expect(t1.lanes.core).toEqual(["topic-x"]);
    expect(t1.lanes.hot).toEqual(["page-b"]);
    expect(loggedSources(1)).toEqual([
      { slug: "topic-x", source: "core" },
      { slug: "page-a", source: "needle" },
    ]);

    // Turn 2: a different query — the stable prefix is unchanged, the finder
    // tail differs, and turn 1's un-re-selected page-a does NOT reappear in
    // the result (no carry in orchestration).
    const t2 = await runTurn(2, "durian", ["page-b"], [], { lanes, ...prefix });
    expect(lastPool.slice(0, 2)).toEqual(["topic-x", "page-b"]);
    expect(t2.selections.map((s) => s.slug)).toEqual(["page-b"]);
    expect(loggedSources(2)).toEqual([{ slug: "page-b", source: "hot" }]);
  });

  test("a finder hit on a core page logs core, not the finder lane", async () => {
    const lanes = await buildLanes();
    // "apple" hits page-a via the needle, but page-a is CORE — the pool lists
    // it twice (stable-prefix card + finder snippet line, by design), the
    // selection dedupes to one slug, and the row attributes to core.
    const result = await runTurn(1, "apple", ["page-a"], [], {
      lanes,
      core: ["page-a"],
    });
    expect(lastPool.filter((s) => s === "page-a")).toHaveLength(2);
    expect(result.selections).toEqual([{ slug: "page-a", pinned: false }]);
    expect(result.lanes.finder.map((c) => c.slug)).toContain("page-a");
    expect(loggedSources(1)).toEqual([{ slug: "page-a", source: "core" }]);
  });
});

// ---------------------------------------------------------------------------
// Lane-source attribution: a synthetic capability page now carries a section
// (its rendered content), so when the needle ranks it the selection has a
// matched section and is attributed `needle` — exactly like a concept page.
// ---------------------------------------------------------------------------

describe("memory-v3 integration — lane-source attribution", () => {
  test("a needle-ranked capability selection is logged with the needle source", async () => {
    const lanes = await buildLanes();
    // "durian" matches the capability page's content section, so selecting it
    // records a `matchedSections` entry and the lane mapping attributes it
    // `needle` (capabilities are indexed pages now, not sectionless add-ins).
    const result = await runTurn(1, "durian", [CAPABILITY_SLUG], [], { lanes });
    expect(result.selections.map((s) => s.slug)).toEqual([CAPABILITY_SLUG]);
    expect(loggedSources(1)).toEqual([
      { slug: CAPABILITY_SLUG, source: "needle" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// A/B readout: summarizeSelections aggregates the logged run by lane
// source, and reports turn count + distinct-slug selection footprint.
// ---------------------------------------------------------------------------

describe("memory-v3 integration — selection-log readout", () => {
  test("summarizeSelections aggregates a multi-turn run by source", async () => {
    const lanes = await buildLanes();
    const prefix = { hot: ["topic-x"] };

    // Turn 1: needle selects page-a (matched "apple"), plus the hot topic-x.
    await runTurn(1, "apple", ["page-a", "topic-x"], [], { lanes, ...prefix });
    // Turn 2: needle selects page-b (matched "banana"); dense also surfaces it
    // (denseK enables the lane), but needle precedence wins the attribution.
    denseHits = [{ article: "page-b", section: 0 }];
    await runTurn(2, "banana", ["page-b"], [], {
      lanes,
      ...prefix,
      denseK: 100,
    });
    // Turn 3: needle selects the capability page (matched "durian" in its
    // content).
    denseHits = [];
    await runTurn(3, "durian", [CAPABILITY_SLUG], [], { lanes, ...prefix });

    const summary = summarizeSelections(CONV);
    // needle: page-a (t1) + page-b (t2) + capability page (t3) = 3.
    expect(summary.bySource.needle).toBe(3);
    // hot: topic-x (t1).
    expect(summary.bySource.hot).toBe(1);
    // No selection was attributed to the core or edge lanes in this run.
    expect(summary.bySource.core).toBe(0);
    expect(summary.bySource.edge).toBe(0);
    // dense lane surfaced candidates but none were selected.
    expect(summary.bySource.dense).toBe(0);
    // Three turns logged selections.
    expect(summary.turns).toBe(3);
    // Distinct slugs across the run: page-a, topic-x, page-b, the capability
    // page.
    expect(summary.distinctSlugs).toBe(4);
  });

  test("summarizeSelections reports zeros for a conversation with no rows", () => {
    const summary = summarizeSelections("conv-empty");
    expect(summary).toEqual({
      bySource: {
        core: 0,
        hot: 0,
        fresh: 0,
        needle: 0,
        dense: 0,
        edge: 0,
        reply: 0,
        learned: 0,
        entity: 0,
      },
      turns: 0,
      distinctSlugs: 0,
    });
  });
});
