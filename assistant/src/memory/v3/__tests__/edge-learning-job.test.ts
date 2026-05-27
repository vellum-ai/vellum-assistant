/**
 * Tests for `assistant/src/memory/v3/auto-edges.ts`, `edge-learning-job.ts`,
 * and their sibling migration `263-memory-v3-auto-edges.ts`.
 *
 * Coverage:
 *   - Migration creates the table + weight index; safe to re-run; down drops it.
 *   - reinforce upserts and accrues weight on the (source, target) PK.
 *   - decay multiplicatively reduces unused weights and prunes near-zero edges.
 *   - aboveThreshold returns exactly the edge-expansion `extraAdjacency` shape.
 *   - A job run over fixture co-activations reinforces *used* rows only, skips
 *     unused ones, and emits weight-floored, diversity-capped promotion
 *     candidates. No real LLM, no real workspace DB.
 *
 * Uses an in-memory bun:sqlite database. The checkpoints module is stubbed with
 * an in-memory Map so the watermark works without a real getDb() backing store;
 * runEdgeLearning takes the in-memory DB explicitly for all auto-edge and
 * co-activation reads.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

const checkpointStore = new Map<string, string>();
mock.module("../../checkpoints.js", () => ({
  getMemoryCheckpoint: (key: string) => checkpointStore.get(key) ?? null,
  setMemoryCheckpoint: (key: string, value: string) =>
    checkpointStore.set(key, value),
}));

import type { DrizzleDb } from "../../db-connection.js";
import { getSqliteFrom } from "../../db-connection.js";
import { migrateMemoryV3Coactivation } from "../../migrations/262-memory-v3-coactivation.js";
import {
  downMemoryV3AutoEdges,
  migrateMemoryV3AutoEdges,
} from "../../migrations/263-memory-v3-auto-edges.js";
import * as schema from "../../schema.js";
import {
  aboveThreshold,
  decay,
  reinforce,
  topByWeight,
} from "../auto-edges.js";
import {
  type CoactivationRow,
  recordCoactivations,
} from "../coactivation-store.js";
import {
  EDGE_DECAY_HALF_LIFE_MS,
  MAX_CANDIDATES_PER_SOURCE,
  MAX_PROMOTION_CANDIDATES,
  runEdgeLearning,
} from "../edge-learning-job.js";

// memory_checkpoints is required by withCrashRecovery and normally created by an
// early core migration. Stand it up by hand so the v3 migrations can run in
// isolation against a fresh in-memory DB.
const CHECKPOINTS_DDL = /*sql*/ `
  CREATE TABLE memory_checkpoints (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

let sqlite: Database;
let database: DrizzleDb;

beforeEach(() => {
  sqlite = new Database(":memory:");
  database = drizzle(sqlite, { schema });
  getSqliteFrom(database).exec(CHECKPOINTS_DDL);
  migrateMemoryV3Coactivation(database);
  migrateMemoryV3AutoEdges(database);
  checkpointStore.clear();
});

afterEach(() => {
  sqlite.close();
});

function readWeight(source: string, target: string): number | undefined {
  const row = getSqliteFrom(database)
    .query(
      `SELECT weight FROM memory_v3_auto_edges
        WHERE source_slug = ? AND target_slug = ?`,
    )
    .get(source, target) as { weight: number } | undefined;
  return row?.weight;
}

// ---------------------------------------------------------------------------
// Migration.
// ---------------------------------------------------------------------------

describe("migrateMemoryV3AutoEdges", () => {
  test("creates table and weight index; safe to re-run", () => {
    migrateMemoryV3AutoEdges(database);
    migrateMemoryV3AutoEdges(database);

    const raw = getSqliteFrom(database);
    const table = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_v3_auto_edges'`,
      )
      .get();
    expect(table).toBeTruthy();

    const indexNames = new Set(
      (
        raw
          .query(
            `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_v3_auto_edges'`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    expect(indexNames.has("idx_memory_v3_auto_edges_weight")).toBe(true);
  });

  test("downMemoryV3AutoEdges drops the table", () => {
    downMemoryV3AutoEdges(database);
    const table = getSqliteFrom(database)
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_v3_auto_edges'`,
      )
      .get();
    expect(table).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// auto-edges store.
// ---------------------------------------------------------------------------

describe("reinforce", () => {
  test("inserts a new pair at the increment, then accrues on the PK", () => {
    reinforce(database, "a", "b", 1_000);
    expect(readWeight("a", "b")).toBe(1);
    reinforce(database, "a", "b", 2_000);
    expect(readWeight("a", "b")).toBe(2);
  });

  test("directed pairs are independent", () => {
    reinforce(database, "a", "b", 1_000);
    reinforce(database, "b", "a", 1_000);
    expect(readWeight("a", "b")).toBe(1);
    expect(readWeight("b", "a")).toBe(1);
  });
});

describe("decay", () => {
  test("halves a weight after one half-life and advances last_reinforced_at", () => {
    reinforce(database, "a", "b", 0);
    // Push it above the half-life so the decayed weight stays above the floor.
    reinforce(database, "a", "b", 0); // weight = 2
    const pruned = decay(
      database,
      EDGE_DECAY_HALF_LIFE_MS,
      EDGE_DECAY_HALF_LIFE_MS,
    );
    expect(pruned).toBe(0);
    const w = readWeight("a", "b")!;
    expect(w).toBeCloseTo(1, 5);

    const stamped = getSqliteFrom(database)
      .query(
        `SELECT last_reinforced_at FROM memory_v3_auto_edges
          WHERE source_slug='a' AND target_slug='b'`,
      )
      .get() as { last_reinforced_at: number };
    expect(stamped.last_reinforced_at).toBe(EDGE_DECAY_HALF_LIFE_MS);
  });

  test("prunes edges that decay below the floor", () => {
    reinforce(database, "a", "b", 0);
    // Ten half-lives ⇒ weight × 2^-10 ≈ 0.001 < floor.
    const pruned = decay(
      database,
      10 * EDGE_DECAY_HALF_LIFE_MS,
      EDGE_DECAY_HALF_LIFE_MS,
    );
    expect(pruned).toBe(1);
    expect(readWeight("a", "b")).toBeUndefined();
  });

  test("clamps future timestamps so decay never amplifies weight", () => {
    reinforce(database, "a", "b", 10_000);
    // now < last_reinforced_at ⇒ elapsed clamps to 0 ⇒ weight unchanged.
    decay(database, 0, EDGE_DECAY_HALF_LIFE_MS);
    expect(readWeight("a", "b")).toBe(1);
  });
});

describe("aboveThreshold", () => {
  test("returns the source → Set<target> adjacency for above-threshold pairs", () => {
    reinforce(database, "a", "b", 0); // weight 1
    reinforce(database, "a", "c", 0);
    reinforce(database, "a", "c", 0); // weight 2
    reinforce(database, "x", "y", 0); // weight 1

    const adjacency = aboveThreshold(database, 2);
    // Only a→c clears the threshold of 2.
    expect([...adjacency.keys()]).toEqual(["a"]);
    expect([...adjacency.get("a")!]).toEqual(["c"]);

    const inclusive = aboveThreshold(database, 1);
    expect([...inclusive.get("a")!].sort()).toEqual(["b", "c"]);
    expect([...inclusive.get("x")!]).toEqual(["y"]);
  });

  test("empty when nothing clears the threshold", () => {
    reinforce(database, "a", "b", 0);
    expect(aboveThreshold(database, 5).size).toBe(0);
  });
});

describe("topByWeight", () => {
  test("returns heaviest edges first, capped at limit", () => {
    reinforce(database, "a", "b", 0);
    reinforce(database, "a", "b", 0); // weight 2
    reinforce(database, "c", "d", 0); // weight 1
    const top = topByWeight(database, 1);
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({
      sourceSlug: "a",
      targetSlug: "b",
      weight: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// edge-learning job.
// ---------------------------------------------------------------------------

function coact(
  source: string,
  target: string,
  used: number,
  createdAt: number,
): CoactivationRow {
  return {
    conversationId: "conv-1",
    turn: 1,
    sourceSlug: source,
    targetSlug: target,
    passGap: 1,
    used,
    createdAt,
  };
}

describe("runEdgeLearning", () => {
  test("reinforces used co-activations only and skips unused ones", () => {
    recordCoactivations(database, [
      coact("a", "b", 1, 100),
      coact("a", "b", 1, 200),
      coact("c", "d", 0, 300),
    ]);

    const result = runEdgeLearning(database, 1_000);
    expect(result.reinforced).toBe(2);
    expect(result.skippedUnused).toBe(1);
    expect(readWeight("a", "b")).toBe(2);
    expect(readWeight("c", "d")).toBeUndefined();
  });

  test("advances the watermark so the same co-activation isn't re-counted", () => {
    recordCoactivations(database, [coact("a", "b", 1, 100)]);
    runEdgeLearning(database, 1_000);
    expect(readWeight("a", "b")).toBe(1);

    // Second run with no new co-activations: only decay, no fresh reinforcement.
    const second = runEdgeLearning(database, 1_000);
    expect(second.reinforced).toBe(0);
    expect(readWeight("a", "b")).toBe(1);

    // A newer co-activation past the watermark is picked up.
    recordCoactivations(database, [coact("a", "b", 1, 500)]);
    const third = runEdgeLearning(database, 1_000);
    expect(third.reinforced).toBe(1);
    expect(readWeight("a", "b")).toBe(2);
  });

  test("emits promotion candidates above the weight floor", () => {
    // Two used co-activations ⇒ weight 2 ≥ floor (1.5); single ⇒ weight 1 < floor.
    recordCoactivations(database, [
      coact("a", "b", 1, 100),
      coact("a", "b", 1, 200),
      coact("c", "d", 1, 300),
    ]);
    const result = runEdgeLearning(database, 1_000);
    const pairs = result.candidates.map(
      (c) => `${c.sourceSlug}->${c.targetSlug}`,
    );
    expect(pairs).toEqual(["a->b"]);
  });

  test("caps candidates per source so one hub can't monopolize the slate", () => {
    const rows: CoactivationRow[] = [];
    let t = 100;
    // Hub "a" → many targets, each reinforced twice (weight 2 ≥ floor).
    for (let i = 0; i < MAX_CANDIDATES_PER_SOURCE + 3; i++) {
      rows.push(coact("a", `t${i}`, 1, t++));
      rows.push(coact("a", `t${i}`, 1, t++));
    }
    recordCoactivations(database, rows);
    const result = runEdgeLearning(database, 1_000);
    const fromA = result.candidates.filter((c) => c.sourceSlug === "a");
    expect(fromA.length).toBe(MAX_CANDIDATES_PER_SOURCE);
    expect(result.candidates.length).toBeLessThanOrEqual(
      MAX_PROMOTION_CANDIDATES,
    );
  });
});
