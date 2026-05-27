/**
 * Tests for `assistant/src/memory/v3/coretrieval-seed.ts`.
 *
 *   - `buildCoretrievalGraph` (pure): co-occurrence counting, the min-count
 *     floor, the always-on frequency exclusion, NPMI ranking, and the top-K cap.
 *   - `seedCoretrievalEdges` (driver): reads router selections from
 *     `memory_v2_activation_logs`, persists the graph into `memory_v3_auto_edges`
 *     in the shape `aboveThreshold` reads back, and is idempotent.
 *
 * Generic slugs only (page-a, topic-x, …) — no real content.
 */

import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import type { DrizzleDb } from "../../db-connection.js";
import {
  buildCoretrievalGraph,
  seedCoretrievalEdges,
} from "../coretrieval-seed.js";

describe("buildCoretrievalGraph", () => {
  const opts = { minCount: 2, maxNeighborFreqRatio: 1, topK: 10 };

  test("ignores turns with fewer than two distinct slugs", () => {
    const graph = buildCoretrievalGraph(
      [["page-a"], ["page-b"], ["page-a", "page-a"]],
      opts,
    );
    expect(graph.size).toBe(0);
  });

  test("ranks a surprising association above a high-frequency one (NPMI)", () => {
    // page-b appears only ever alongside page-a (perfectly associated); topic-c
    // is high-frequency (appears all over), so its co-occurrence with page-a is
    // unsurprising. NPMI must rank page-b above topic-c for source page-a.
    const turns = [
      ["page-a", "page-b"],
      ["page-a", "page-b"],
      ["page-a", "page-b"],
      ["page-a", "page-b"],
      ["page-a", "topic-c"],
      ["page-a", "topic-c"],
      ["page-a", "topic-c"],
      ["page-a", "topic-c"],
      ["topic-c", "page-d"],
      ["topic-c", "page-d"],
      ["topic-c", "page-d"],
      ["topic-c", "page-d"],
      ["topic-c", "page-d"],
      ["topic-c", "page-d"],
    ];
    const graph = buildCoretrievalGraph(turns, opts);
    const neighbors = graph.get("page-a")!;
    expect(neighbors[0].target).toBe("page-b");
    const bScore = neighbors.find((n) => n.target === "page-b")!.score;
    const cScore = neighbors.find((n) => n.target === "topic-c")?.score ?? -1;
    expect(bScore).toBeGreaterThan(cScore);
  });

  test("drops pairs below the min-count floor", () => {
    const turns = [
      ["page-a", "page-b"],
      ["page-a", "page-b"], // page-a↔page-b co-occur twice
      ["page-a", "page-c"], // page-a↔page-c co-occur once
    ];
    const strict = buildCoretrievalGraph(turns, { ...opts, minCount: 2 });
    const targets = (strict.get("page-a") ?? []).map((n) => n.target);
    expect(targets).toContain("page-b");
    expect(targets).not.toContain("page-c");
  });

  test("excludes always-on neighbors above the frequency ratio", () => {
    // topic-hub appears on every turn (always-on); page-b appears on few. With a
    // 0.5 ratio cap, topic-hub is excluded as a neighbor even though it co-occurs.
    const turns = [
      ["page-a", "page-b", "topic-hub"],
      ["page-a", "page-b", "topic-hub"],
      ["page-x", "topic-hub"],
      ["page-y", "topic-hub"],
    ];
    const graph = buildCoretrievalGraph(turns, {
      minCount: 2,
      maxNeighborFreqRatio: 0.5,
      topK: 10,
    });
    const targets = (graph.get("page-a") ?? []).map((n) => n.target);
    expect(targets).toContain("page-b");
    expect(targets).not.toContain("topic-hub");
  });

  test("caps neighbors at top-K", () => {
    const turns = [
      ["src", "n1", "n2", "n3", "n4"],
      ["src", "n1", "n2", "n3", "n4"],
    ];
    const graph = buildCoretrievalGraph(turns, { ...opts, topK: 2 });
    expect(graph.get("src")!.length).toBe(2);
  });
});

describe("seedCoretrievalEdges", () => {
  function freshDb(): { db: DrizzleDb; sqlite: Database } {
    const sqlite = new Database(":memory:");
    sqlite.run(
      `CREATE TABLE memory_v2_activation_logs (
         id TEXT PRIMARY KEY, mode TEXT NOT NULL, concepts_json TEXT NOT NULL
       )`,
    );
    sqlite.run(
      `CREATE TABLE memory_v3_auto_edges (
         source_slug TEXT NOT NULL, target_slug TEXT NOT NULL,
         weight REAL NOT NULL, last_reinforced_at INTEGER NOT NULL,
         PRIMARY KEY (source_slug, target_slug)
       )`,
    );
    return { db: drizzle(sqlite) as unknown as DrizzleDb, sqlite };
  }

  function insertRouterTurn(
    sqlite: Database,
    id: string,
    slugs: string[],
  ): void {
    const concepts = slugs.map((slug) => ({ slug, status: "injected" }));
    sqlite.run(
      `INSERT INTO memory_v2_activation_logs (id, mode, concepts_json) VALUES (?, 'router', ?)`,
      [id, JSON.stringify(concepts)],
    );
  }

  test("persists the co-retrieval graph in the shape aboveThreshold reads", () => {
    const { db, sqlite } = freshDb();
    for (let i = 0; i < 4; i++) {
      insertRouterTurn(sqlite, `t${i}`, ["page-a", "page-b"]);
    }
    // A non-router row must be ignored.
    sqlite.run(
      `INSERT INTO memory_v2_activation_logs (id, mode, concepts_json) VALUES ('x', 'v3_shadow', ?)`,
      [JSON.stringify([{ slug: "noise-a", status: "injected" }])],
    );

    const result = seedCoretrievalEdges(db, {
      minCount: 2,
      maxNeighborFreqRatio: 1,
      topK: 10,
      seedWeight: 2,
    });

    expect(result.turnsScanned).toBe(4);
    expect(result.edgesWritten).toBeGreaterThan(0);

    // Assert via a direct table read (not auto-edges' aboveThreshold, which a
    // sibling test file mocks) so the seed's persistence is verified in
    // isolation. The edge is symmetric: both directions are written.
    const pairs = (
      sqlite
        .query(
          `SELECT source_slug, target_slug FROM memory_v3_auto_edges WHERE weight >= 1`,
        )
        .all() as Array<{ source_slug: string; target_slug: string }>
    ).map((r) => `${r.source_slug}->${r.target_slug}`);
    expect(pairs).toContain("page-a->page-b");
    expect(pairs).toContain("page-b->page-a");
  });

  test("is idempotent — re-running does not inflate weights", () => {
    const { db, sqlite } = freshDb();
    for (let i = 0; i < 4; i++) {
      insertRouterTurn(sqlite, `t${i}`, ["page-a", "page-b"]);
    }
    const seedOpts = {
      minCount: 2,
      maxNeighborFreqRatio: 1,
      topK: 10,
      seedWeight: 2,
    };
    seedCoretrievalEdges(db, seedOpts);
    seedCoretrievalEdges(db, seedOpts);

    const row = sqlite
      .query(
        `SELECT weight FROM memory_v3_auto_edges WHERE source_slug = 'page-a' AND target_slug = 'page-b'`,
      )
      .get() as { weight: number };
    expect(row.weight).toBe(2);
  });

  test("returns an empty summary when there are no router turns", () => {
    const { db } = freshDb();
    const result = seedCoretrievalEdges(db);
    expect(result).toEqual({
      turnsScanned: 0,
      nodes: 0,
      edgesWritten: 0,
      avgDegree: 0,
    });
  });
});
