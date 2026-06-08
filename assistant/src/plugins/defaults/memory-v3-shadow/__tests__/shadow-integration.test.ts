/**
 * Shadow-mode end-to-end integration test for the memory-v3 section-lane
 * pipeline.
 *
 * SCOPE / ALTITUDE. A full daemon-assembly run (plugin registry → flag read →
 * runtime assembly → provider call → DB write) is too heavy and too
 * mock-fragile for a unit test. Instead this composes the REAL shadow units
 * with a mocked select provider, a stubbed dense lane, an in-memory selections
 * DB, and synthetic fixtures, driving them over a MULTI-TURN sequence:
 *
 *   orchestrate (needle ∪ dense ∪ edge → selectPool over a shared WorkingSet
 *     → carry-forward)
 *       → attribute selections to lane sources (the shadow plugin's coarse
 *         mapping, replicated here)
 *       → write to `memory_v3_selections`
 *       → summarizeSelections (the offline A/B readout)
 *
 * This is exactly the side-effect contract shadow mode observes each turn: the
 * candidate pool is the union of the lanes — synthetic capability pages are
 * indexed like any other page, so they enter through the needle lane rather than
 * being always-added — a SINGLE select runs per turn, the working set carries
 * selections forward across turns, and each selection is logged tagged with its
 * lane source. None of this changes live injection — shadow mode is
 * observation-only; cutover is the `memory-v3-live` flag flip.
 *
 * Slugs are generic placeholders (`page-a`, `topic-x`, `page-b`, …) — this is a
 * public repo.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateAddMemoryV3Selections } from "../../../../memory/migrations/268-add-memory-v3-selections.js";
import * as schema from "../../../../memory/schema.js";
import type { PageIndexEntry } from "../../../../memory/v2/page-index.js";
import type {
  Message,
  Provider,
  ProviderResponse,
} from "../../../../providers/types.js";
import type { EdgeGraph } from "../edge.js";
import { buildEdgeGraph } from "../edge.js";
import type { OrchestrateResult } from "../orchestrate.js";
import { buildSectionNeedle } from "../section-needle.js";
import { buildSectionIndex } from "../sections.js";
import type {
  MemoryRoutingTurn,
  SectionIndex,
  SelectionSource,
  Slug,
} from "../types.js";

// ---------------------------------------------------------------------------
// Module stubs installed BEFORE the orchestrator / store imports so they
// observe them at load time. Every stub DELEGATES to the real implementation
// unless this file's tests are running, so the process-global `mock.module`
// cannot leak fake behavior into sibling test files.
// ---------------------------------------------------------------------------

let mockActive = false;

let providerStub: Provider | null = null;

// Spread the real provider module so unrelated exports (e.g. `createTimeout`,
// pulled in transitively via the selection-log-store render path) stay present;
// override only the two entry points the select pool uses, and only while this
// file is active so the stub cannot leak into sibling tests.
const realProvider = {
  ...(await import("../../../../providers/provider-send-message.js")),
};
mock.module("../../../../providers/provider-send-message.js", () => ({
  ...realProvider,
  getConfiguredProvider: async (
    ...args: Parameters<typeof realProvider.getConfiguredProvider>
  ) =>
    mockActive ? providerStub : realProvider.getConfiguredProvider(...args),
  extractToolUse: (response: ProviderResponse) =>
    response.content.find((b) => b.type === "tool_use"),
}));

mock.module("../../../../util/logger.js", () => ({
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
}));

// In-memory selections DB. `summarizeSelections` reads via getDb/getSqliteFrom;
// the writer below writes through the same handles.
const realDb = { ...(await import("../../../../memory/db-connection.js")) };
let testSqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  testSqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(testSqlite, { schema });
  migrateAddMemoryV3Selections(db);
  return db;
}
mock.module("../../../../memory/db-connection.js", () => ({
  ...realDb,
  getDb: () => (mockActive ? testDb : realDb.getDb()),
  getSqliteFrom: (db: unknown) =>
    mockActive
      ? testSqlite
      : realDb.getSqliteFrom(db as Parameters<typeof realDb.getSqliteFrom>[0]),
}));

const { orchestrate } = await import("../orchestrate.js");
const { WorkingSet } = await import("../working-set.js");
const { summarizeSelections } = await import("../selection-log-store.js");

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

/** Parse the numbered `<candidates>` block back into an ordered slug list. */
function candidateSlugs(messages: Message[]): Slug[] {
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== "text") continue;
      const m = /<candidates>\n([\s\S]*?)\n<\/candidates>/.exec(block.text);
      if (!m) continue;
      return m[1]
        .split("\n")
        .map((line) => /^\[\d+\] (\S+) —/.exec(line)?.[1])
        .filter((s): s is string => !!s);
    }
  }
  return [];
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
// Selection attribution + write. Mirrors the shadow plugin's coarse lane
// mapping (`attributeSelections` / `writeSelections` in shadow-plugin.ts):
// a current selection with a matched section → `needle`, else `edge`; a
// carry-forward-only slug → `carry-forward`. Replicated here (rather than
// imported) so the test stays self-contained and does not pull in the shadow
// plugin's heavy module graph (page-index / page-store / dense store).
// ---------------------------------------------------------------------------

interface SelectionRow {
  slug: Slug;
  source: SelectionSource;
  pinned: number;
}

function attributeSelections(result: OrchestrateResult): SelectionRow[] {
  const rows: SelectionRow[] = [];
  const seen = new Set<Slug>();
  for (const sel of result.currentSelections) {
    seen.add(sel.slug);
    rows.push({
      slug: sel.slug,
      source: result.sectionBySlug.has(sel.slug) ? "needle" : "edge",
      pinned: sel.pinned ? 1 : 0,
    });
  }
  for (const slug of result.finalInjection) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    rows.push({ slug, source: "carry-forward", pinned: 0 });
  }
  return rows;
}

function writeSelections(turn: number, rows: SelectionRow[]): void {
  if (rows.length === 0) return;
  const stmt = testSqlite.query(
    `INSERT OR REPLACE INTO memory_v3_selections
       (conversation_id, turn, slug, source, pinned, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  for (const row of rows) {
    stmt.run(CONV, turn, row.slug, row.source, row.pinned, now);
  }
}

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
    workingSet: InstanceType<typeof WorkingSet>;
  },
): Promise<OrchestrateResult> {
  providerStub = selectProvider(keep, pin);
  const result = await orchestrate(makeTurn(turnNumber, query), {
    sectionIndex: deps.lanes.sectionIndex,
    needle: deps.lanes.needle,
    denseConfig: config,
    edgeGraph: deps.lanes.edgeGraph,
    workingSet: deps.workingSet,
  });
  writeSelections(turnNumber, attributeSelections(result));
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

describe("memory-v3 shadow integration — candidate pool", () => {
  test("pool unions needle ∪ dense ∪ edge; one select per turn", async () => {
    const lanes = await buildLanes();
    // "apple" hits page-a (needle). Dense returns page-b. page-a links to
    // topic-x (edge). "apple" does NOT match the capability page, so it is not
    // pooled this turn — capability pages are lane-ranked, not always-added.
    denseHits = [{ article: "page-b", section: 0 }];
    await runTurn(1, "apple", [], [], { lanes, workingSet: new WorkingSet() });

    expect(selectCalls).toBe(1);
    expect(new Set(lastPool)).toEqual(new Set(["page-a", "page-b", "topic-x"]));
  });

  test("a synthetic capability page enters the pool via the needle lane", async () => {
    const lanes = await buildLanes();
    // "durian" is the distinctive term in the capability page's content, so the
    // real needle ranks it and folds it into the pool.
    await runTurn(1, "durian", [], [], { lanes, workingSet: new WorkingSet() });

    expect(selectCalls).toBe(1);
    expect(lastPool).toContain(CAPABILITY_SLUG);
  });
});

// ---------------------------------------------------------------------------
// Carry-forward across turns: a page selected on turn 1 stays in turn 2's
// final injection without being re-selected (net-new shadow behavior), and is
// logged as `carry-forward` on the later turn.
// ---------------------------------------------------------------------------

describe("memory-v3 shadow integration — carry-forward", () => {
  test("a turn-1 selection accumulates into turn 2's injection and logs as carry-forward", async () => {
    const lanes = await buildLanes();
    const workingSet = new WorkingSet();

    // Turn 1 selects+pins page-a (needle-sourced).
    const t1 = await runTurn(1, "apple", ["page-a"], ["page-a"], {
      lanes,
      workingSet,
    });
    expect(t1.currentSelections.map((s) => s.slug)).toContain("page-a");
    expect(loggedSources(1)).toEqual([{ slug: "page-a", source: "needle" }]);

    // Turn 2 selects a DIFFERENT page; page-a carries forward un-re-selected.
    denseHits = [{ article: "topic-x", section: 0 }];
    const t2 = await runTurn(2, "cherry", ["topic-x"], [], {
      lanes,
      workingSet,
    });
    expect(t2.currentSelections.map((s) => s.slug)).not.toContain("page-a");
    expect(t2.finalInjection).toContain("page-a");

    // The carried page is logged with the carry-forward source tag.
    const t2Rows = loggedSources(2);
    expect(t2Rows).toContainEqual({ slug: "topic-x", source: "needle" });
    expect(t2Rows).toContainEqual({ slug: "page-a", source: "carry-forward" });

    // Working set accumulates both pages across the two turns.
    expect(workingSet.union()).toEqual(new Set(["page-a", "topic-x"]));
  });
});

// ---------------------------------------------------------------------------
// Lane-source attribution: a synthetic capability page now carries a section
// (its rendered content), so when the needle ranks it the selection has a
// matched section and is attributed `needle` — exactly like a concept page.
// ---------------------------------------------------------------------------

describe("memory-v3 shadow integration — lane-source attribution", () => {
  test("a needle-ranked capability selection is logged with the needle source", async () => {
    const lanes = await buildLanes();
    // "durian" matches the capability page's content section, so selecting it
    // records a `sectionBySlug` entry and the coarse mapping attributes it
    // `needle` (capabilities are indexed pages now, not sectionless add-ins).
    const result = await runTurn(1, "durian", [CAPABILITY_SLUG], [], {
      lanes,
      workingSet: new WorkingSet(),
    });
    expect(result.currentSelections.map((s) => s.slug)).toEqual([
      CAPABILITY_SLUG,
    ]);
    expect(loggedSources(1)).toEqual([
      { slug: CAPABILITY_SLUG, source: "needle" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// A/B readout: summarizeSelections aggregates the logged shadow run by lane
// source, and reports turn count + distinct-slug (working-set) footprint.
// ---------------------------------------------------------------------------

describe("memory-v3 shadow integration — selection-log readout", () => {
  test("summarizeSelections aggregates a multi-turn run by source", async () => {
    const lanes = await buildLanes();
    const workingSet = new WorkingSet();

    // Turn 1: needle selects page-a (matched "apple").
    await runTurn(1, "apple", ["page-a"], [], { lanes, workingSet });
    // Turn 2: needle selects page-b (matched "banana"); page-a carries forward.
    denseHits = [{ article: "page-b", section: 0 }];
    await runTurn(2, "banana", ["page-b"], [], { lanes, workingSet });
    // Turn 3: needle selects the capability page (matched "durian" in its
    // content); page-a and page-b carry forward.
    denseHits = [];
    await runTurn(3, "durian", [CAPABILITY_SLUG], [], { lanes, workingSet });

    const summary = summarizeSelections(CONV);
    // needle: page-a (t1) + page-b (t2) + capability page (t3) = 3.
    expect(summary.bySource.needle).toBe(3);
    // No selection was attributed to the edge lane in this run.
    expect(summary.bySource.edge).toBe(0);
    // carry-forward: page-a (t2) + page-a & page-b (t3) = 3.
    expect(summary.bySource["carry-forward"]).toBe(3);
    // dense lane surfaced candidates but none were selected.
    expect(summary.bySource.dense).toBe(0);
    // Three turns logged selections.
    expect(summary.turns).toBe(3);
    // Distinct slugs across the run: page-a, page-b, the capability page.
    expect(summary.distinctSlugs).toBe(3);
  });

  test("summarizeSelections reports zeros for a conversation with no rows", () => {
    const summary = summarizeSelections("conv-empty");
    expect(summary).toEqual({
      bySource: { needle: 0, dense: 0, edge: 0, "carry-forward": 0 },
      turns: 0,
      distinctSlugs: 0,
    });
  });
});
