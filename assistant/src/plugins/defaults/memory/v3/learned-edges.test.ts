/**
 * Tests for the learned-edge lane (`learned-edges.ts`).
 *
 * `computeLearnedEdgeGraph` reads `memory_v3_selections` over the dedicated
 * memory connection: each test installs an in-memory SQLite db into the
 * `memory` singleton slot (where the accessor resolves its connection), seeds
 * it with selection rows, and asserts the NPMI association graph. Rows
 * sharing a `(conversation_id, created_at)` form one selector call.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import {
  clearStoredDb,
  setStoredDb,
} from "../../../../persistence/db-singleton.js";
import { ensureMemoryV3SelectionsSchema } from "../../../../persistence/migrations/338-move-memory-v3-selections-to-memory-db.js";
import * as schema from "../../../../persistence/schema/index.js";
import {
  computeLearnedEdgeGraph,
  type LearnedEdgesOptions,
} from "./learned-edges.js";

const HALF_LIFE_MS = 1_000_000;
const NOW = 100_000;

let sqlite: Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  ensureMemoryV3SelectionsSchema(sqlite);
  setStoredDb("memory", drizzle(sqlite, { schema }), () => sqlite.close());
});

afterEach(() => {
  clearStoredDb("memory");
});

let nextTurn = 0;
/** Insert one selector call: every slug shares the same (conv, created_at). */
function seedCall(slugs: string[], createdAt = NOW, conv = "conv-1"): void {
  const stmt = sqlite.query(
    `INSERT INTO memory_v3_selections (conversation_id, turn, slug, source, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const turn = nextTurn++;
  for (const slug of slugs) {
    stmt.run(conv, turn, slug, "needle", 0, createdAt);
  }
}

function graphOf(overrides: Partial<LearnedEdgesOptions> = {}) {
  return computeLearnedEdgeGraph({
    halfLifeMs: HALF_LIFE_MS,
    minCount: 2,
    npmiFloor: 0.2,
    maxPerPage: 6,
    now: NOW,
    windowMs: NOW,
    knownSlugs: new Set([
      "page-a",
      "page-b",
      "page-c",
      "page-d",
      "skills/widget",
    ]),
    ...overrides,
  });
}

const peersOf = (
  graph: ReturnType<typeof computeLearnedEdgeGraph>,
  slug: string,
): string[] => [...(graph.adjacency.get(slug)?.keys() ?? [])];

describe("computeLearnedEdgeGraph", () => {
  test("pages selected together (and rarely apart) form a symmetric edge", () => {
    // a+b co-select twice; c selects alone twice (so a/b are not ubiquitous).
    seedCall(["page-a", "page-b"], NOW, "conv-1");
    seedCall(["page-a", "page-b"], NOW, "conv-2");
    seedCall(["page-c"], NOW, "conv-3");
    seedCall(["page-c"], NOW, "conv-4");

    const graph = graphOf();
    expect(peersOf(graph, "page-a")).toEqual(["page-b"]);
    expect(peersOf(graph, "page-b")).toEqual(["page-a"]);
    expect(graph.hubs.size).toBe(0);
  });

  test("a page selected in every call forms no edges (NPMI → 0)", () => {
    // page-a rides every call; page-b/page-c each appear half the time.
    seedCall(["page-a", "page-b"], NOW, "conv-1");
    seedCall(["page-a", "page-b"], NOW, "conv-2");
    seedCall(["page-a", "page-c"], NOW, "conv-3");
    seedCall(["page-a", "page-c"], NOW, "conv-4");

    const graph = graphOf();
    // p(a) = 1 ⇒ p(a,b) = p(b) ⇒ npmi = 0, floored out — for every pairing.
    expect(peersOf(graph, "page-a")).toEqual([]);
    expect(peersOf(graph, "page-b")).toEqual([]);
  });

  test("a pair co-selected in every call forms no edge (NPMI is undefined)", () => {
    // Every in-window call selects exactly {a, b}: pab = pa = pb = 1, so the
    // NPMI normalizer -log(pab) is -0 and the score is NaN. NaN must not slip
    // past the floor into the adjacency (it would also corrupt the
    // strongest-first neighbor ordering).
    seedCall(["page-a", "page-b"], NOW, "conv-1");
    seedCall(["page-a", "page-b"], NOW, "conv-2");
    seedCall(["page-a", "page-b"], NOW, "conv-3");

    const graph = graphOf();
    expect(peersOf(graph, "page-a")).toEqual([]);
    expect(peersOf(graph, "page-b")).toEqual([]);
  });

  test("pairs below the co-occurrence mass floor form no edge", () => {
    seedCall(["page-a", "page-b"], NOW, "conv-1"); // mass ≈ 1 < minCount 2
    seedCall(["page-c"], NOW, "conv-2");
    seedCall(["page-d"], NOW, "conv-3");

    const graph = graphOf();
    expect(peersOf(graph, "page-a")).toEqual([]);
  });

  test("decay pushes old co-selections below the mass floor", () => {
    // Two co-selections ten half-lives ago: decayed mass ≈ 0.002 < 2.
    seedCall(["page-a", "page-b"], NOW - 10 * HALF_LIFE_MS, "conv-1");
    seedCall(["page-a", "page-b"], NOW - 10 * HALF_LIFE_MS, "conv-2");
    seedCall(["page-c"], NOW, "conv-3");

    const graph = graphOf({ windowMs: 20 * HALF_LIFE_MS });
    expect(peersOf(graph, "page-a")).toEqual([]);
  });

  test("maxPerPage keeps the strongest associations first", () => {
    // page-a co-selects with b twice and with c once alongside others, making
    // a↔b the stronger association; cap page-a to one edge.
    seedCall(["page-a", "page-b"], NOW, "conv-1");
    seedCall(["page-a", "page-b"], NOW, "conv-2");
    seedCall(["page-a", "page-c", "page-d"], NOW, "conv-3");
    seedCall(["page-a", "page-c", "page-d"], NOW, "conv-4");
    seedCall(["page-d"], NOW, "conv-5");
    seedCall(["page-d"], NOW, "conv-6");

    const graph = graphOf({ maxPerPage: 1 });
    expect(peersOf(graph, "page-a")).toEqual(["page-b"]);
  });

  test("capability slugs participate like any page", () => {
    seedCall(["skills/widget", "page-a"], NOW, "conv-1");
    seedCall(["skills/widget", "page-a"], NOW, "conv-2");
    seedCall(["page-b"], NOW, "conv-3");
    seedCall(["page-b"], NOW, "conv-4");

    const graph = graphOf();
    expect(peersOf(graph, "skills/widget")).toEqual(["page-a"]);
    expect(peersOf(graph, "page-a")).toEqual(["skills/widget"]);
  });

  test("slugs outside knownSlugs never form edges", () => {
    seedCall(["page-a", "deleted-page"], NOW, "conv-1");
    seedCall(["page-a", "deleted-page"], NOW, "conv-2");
    seedCall(["page-b"], NOW, "conv-3");

    const graph = graphOf();
    expect(peersOf(graph, "page-a")).toEqual([]);
    expect(graph.adjacency.has("deleted-page")).toBe(false);
  });

  test("maxPerPage = 0 disables the lane", () => {
    seedCall(["page-a", "page-b"], NOW, "conv-1");
    seedCall(["page-a", "page-b"], NOW, "conv-2");

    const graph = graphOf({ maxPerPage: 0 });
    expect(graph.adjacency.size).toBe(0);
  });

  test("rows outside the scan window are ignored", () => {
    seedCall(["page-a", "page-b"], NOW - 50_000, "conv-1");
    seedCall(["page-a", "page-b"], NOW - 60_000, "conv-2");

    const graph = graphOf({ windowMs: 10_000 });
    expect(graph.adjacency.size).toBe(0);
  });

  test("degrades to an empty graph when the memory database is unavailable", () => {
    // Simulate unavailability through the singleton slot instead of
    // `mock.module`, which is process-global and leaks into sibling test
    // files. The accessor extracts the raw connection from the stored
    // handle's `$client`, so a handle without one makes `getMemorySqlite()`
    // resolve to null, the same contract computeLearnedEdgeGraph sees when
    // the dedicated open fails.
    clearStoredDb("memory");
    setStoredDb("memory", { $client: null }, () => {});

    const graph = graphOf();
    expect(graph.adjacency.size).toBe(0);
    expect(graph.hubs.size).toBe(0);
  });
});
