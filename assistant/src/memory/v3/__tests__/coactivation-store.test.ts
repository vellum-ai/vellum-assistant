/**
 * Tests for `assistant/src/memory/v3/coactivation-store.ts`, its sibling
 * migration `262-memory-v3-coactivation.ts`, and the loop's co-activation
 * emission (`loop.ts`, gated by `config.memory.v3.write.coactivation`).
 *
 * Coverage:
 *   - Migration creates the table + both indexes; safe to re-run.
 *   - recordCoactivations / readCoactivations round-trip; empty list is a
 *     no-op; `since` filters by created_at.
 *   - A scripted 2-pass loop emits the expected pass-1 → pass-2 rows with the
 *     correct pass_gap when the flag is on, and nothing when it is off.
 *
 * Uses an in-memory bun:sqlite database — no real workspace DB. The loop's
 * lane modules are stubbed via `mock.module`, matching `loop.test.ts`.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import type { DrizzleDb } from "../../db-connection.js";
import { getSqliteFrom } from "../../db-connection.js";
import {
  downMemoryV3Coactivation,
  migrateMemoryV3Coactivation,
} from "../../migrations/262-memory-v3-coactivation.js";
import * as schema from "../../schema.js";
import type {
  RetrievalInput,
  RetrievalOutput,
} from "../../v2/harness/retriever.js";
import type { GateDecision, ScoutResult } from "../../v2/harness/trace.js";
import {
  type CoactivationRow,
  readCoactivations,
  recordCoactivations,
} from "../coactivation-store.js";

// memory_checkpoints is required by withCrashRecovery and is normally created
// by an early core migration. Stand it up by hand so the v3 migration can run
// in isolation against a fresh in-memory DB.
const CHECKPOINTS_DDL = /*sql*/ `
  CREATE TABLE memory_checkpoints (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

// ---------------------------------------------------------------------------
// Loop lane stubs — installed before importing the module under test. Mirrors
// loop.test.ts: each test rewires the `lane` refs before calling the loop.
// ---------------------------------------------------------------------------

interface RunScoutsResult {
  scouts: ScoutResult[];
  sticky: Set<string>;
  bypass: Set<string>;
}
interface FilterResult {
  kept: string[];
  trace: { judged: string[]; dropped: string[] };
  failureReason?: string;
}
interface WalkResult {
  pages: Set<string>;
  levels: Array<{
    node: string;
    considered: string[];
    descended: string[];
    skipped: string[];
    reasoning: string;
  }>;
}
interface ExpandResult {
  pulled: Set<string>;
  expansions: Array<{ from: string; pulled: string[] }>;
}
interface GateResult {
  decision: GateDecision;
  selectedSlugs: string[];
}

const lane = {
  scouts: [] as RunScoutsResult[],
  filter: [] as FilterResult[],
  walk: [] as WalkResult[],
  edges: [] as ExpandResult[],
  gate: [] as GateResult[],
};

function nextOf<T>(list: T[], index: number): T {
  return list[Math.min(index, list.length - 1)];
}

let scoutCallCount = 0;
let filterCallCount = 0;
let walkCallCount = 0;
let edgeCallCount = 0;
let gateCallCount = 0;

mock.module("../scouts.js", () => ({
  runScouts: async (): Promise<RunScoutsResult> =>
    nextOf(lane.scouts, scoutCallCount++),
}));
mock.module("../filter.js", () => ({
  filterDenseHits: async (): Promise<FilterResult> =>
    nextOf(lane.filter, filterCallCount++),
}));
mock.module("../tree-walk.js", () => ({
  runTreeWalk: async (): Promise<WalkResult> =>
    nextOf(lane.walk, walkCallCount++),
}));
mock.module("../edges.js", () => ({
  expandEdges: async (): Promise<ExpandResult> =>
    nextOf(lane.edges, edgeCallCount++),
}));
mock.module("../gate.js", () => ({
  runGate: async (): Promise<GateResult> => nextOf(lane.gate, gateCallCount++),
}));
mock.module("../tree-index.js", () => ({
  getTreeIndex: async () => ({
    nodes: new Map(),
    childrenByNode: new Map(),
    parentsByNode: new Map(),
    pageParents: new Map(),
    root: "_root",
  }),
}));
mock.module("../../v2/page-index.js", () => ({
  getPageIndex: async () => ({
    entries: [],
    bySlug: new Map(),
    byId: new Map(),
    rendered: "",
  }),
}));

const { runRetrievalLoop } = await import("../loop.js");

let sqlite: Database;
let database: DrizzleDb;

beforeEach(() => {
  sqlite = new Database(":memory:");
  database = drizzle(sqlite, { schema });
  getSqliteFrom(database).exec(CHECKPOINTS_DDL);
  migrateMemoryV3Coactivation(database);

  lane.scouts = [];
  lane.filter = [];
  lane.walk = [];
  lane.edges = [];
  lane.gate = [];
  scoutCallCount = 0;
  filterCallCount = 0;
  walkCallCount = 0;
  edgeCallCount = 0;
  gateCallCount = 0;
});

afterEach(() => {
  sqlite.close();
});

function scout(laneName: ScoutResult["lane"], slugs: string[]): ScoutResult {
  return { lane: laneName, slugs };
}

function makeInput(opts?: {
  passCap?: number;
  coactivation?: boolean;
}): RetrievalInput {
  return {
    workspaceDir: "/tmp/does-not-matter",
    recentTurnPairs: [],
    nowText: "NOW",
    priorEverInjected: [],
    config: {
      memory: {
        v3: {
          passCap: opts?.passCap ?? 3,
          lanes: {
            hot: true,
            sparse: true,
            dense: true,
            tree: true,
            edges: true,
          },
          write: {
            enabled: false,
            consolidateIntervalMs: 3600000,
            coactivation: opts?.coactivation ?? false,
          },
        },
      },
    } as unknown as RetrievalInput["config"],
  };
}

// ---------------------------------------------------------------------------
// Migration.
// ---------------------------------------------------------------------------

describe("migrateMemoryV3Coactivation", () => {
  test("creates table and both indexes; safe to re-run", () => {
    migrateMemoryV3Coactivation(database);
    migrateMemoryV3Coactivation(database);

    const raw = getSqliteFrom(database);
    const table = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_v3_coactivation'`,
      )
      .get();
    expect(table).toBeTruthy();

    const indexNames = new Set(
      (
        raw
          .query(
            `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_v3_coactivation'`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    expect(indexNames.has("idx_memory_v3_coactivation_pair")).toBe(true);
    expect(indexNames.has("idx_memory_v3_coactivation_time")).toBe(true);
  });

  test("downMemoryV3Coactivation drops the table", () => {
    downMemoryV3Coactivation(database);
    const table = getSqliteFrom(database)
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_v3_coactivation'`,
      )
      .get();
    expect(table).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Store.
// ---------------------------------------------------------------------------

describe("recordCoactivations / readCoactivations", () => {
  test("round-trips rows oldest-first", () => {
    const rows: CoactivationRow[] = [
      {
        conversationId: "conv-1",
        turn: 3,
        sourceSlug: "alice",
        targetSlug: "bob",
        passGap: 1,
        used: 0,
        createdAt: 1_000,
      },
      {
        conversationId: "conv-1",
        turn: 3,
        sourceSlug: "alice",
        targetSlug: "carol",
        passGap: 2,
        used: 0,
        createdAt: 2_000,
      },
    ];
    recordCoactivations(database, rows);

    const read = readCoactivations(database);
    expect(read).toHaveLength(2);
    expect(read[0]).toMatchObject({
      conversationId: "conv-1",
      turn: 3,
      sourceSlug: "alice",
      targetSlug: "bob",
      passGap: 1,
      used: 0,
      createdAt: 1_000,
    });
    expect(read[1].targetSlug).toBe("carol");
    expect(read[1].passGap).toBe(2);
  });

  test("empty list is a no-op", () => {
    recordCoactivations(database, []);
    expect(readCoactivations(database)).toHaveLength(0);
  });

  test("since filters by created_at", () => {
    recordCoactivations(database, [
      {
        conversationId: "c",
        turn: 1,
        sourceSlug: "a",
        targetSlug: "b",
        passGap: 1,
        used: 0,
        createdAt: 100,
      },
      {
        conversationId: "c",
        turn: 1,
        sourceSlug: "a",
        targetSlug: "c",
        passGap: 1,
        used: 0,
        createdAt: 500,
      },
    ]);
    const recent = readCoactivations(database, 300);
    expect(recent).toHaveLength(1);
    expect(recent[0].targetSlug).toBe("c");
  });
});

// ---------------------------------------------------------------------------
// Loop emission.
// ---------------------------------------------------------------------------

describe("runRetrievalLoop — co-activation emission", () => {
  /**
   * Script a 2-pass loop: pass 1 surfaces `a` (hot) + `b` (sparse); pass 2
   * surfaces `c` (dense). The gate says "more" on pass 1 (selecting a, b) and
   * "ready" on pass 2 (selecting a, b, c). So `c` is the only pass-2 target,
   * paired with pass-1 hits a and b → two rows, both pass_gap=1.
   */
  function scriptTwoPass(): void {
    lane.scouts = [
      {
        scouts: [scout("hot", ["a"]), scout("sparse", ["b"])],
        sticky: new Set(),
        bypass: new Set(),
      },
      {
        scouts: [scout("dense", ["c"])],
        sticky: new Set(),
        bypass: new Set(),
      },
    ];
    // Pass 1 has no dense scout, so the filter is only called on pass 2 (one
    // filter call per dense pass) — its single entry keeps `c`.
    lane.filter = [{ kept: ["c"], trace: { judged: ["c"], dropped: [] } }];
    lane.walk = [
      { pages: new Set(), levels: [] },
      { pages: new Set(), levels: [] },
    ];
    lane.edges = [
      { pulled: new Set(), expansions: [] },
      { pulled: new Set(), expansions: [] },
    ];
    lane.gate = [
      {
        decision: { decision: "more", questions: ["q"] },
        selectedSlugs: ["a", "b"],
      },
      { decision: { decision: "ready" }, selectedSlugs: ["a", "b", "c"] },
    ];
  }

  test("emits pass-1 → pass-2 rows with correct pass_gap when flag is on", async () => {
    scriptTwoPass();
    const out: RetrievalOutput = await runRetrievalLoop(
      makeInput({ passCap: 3, coactivation: true }),
      { db: database, conversationId: "conv-42", turn: 7 },
    );
    expect(out.selectedSlugs).toEqual(["a", "b", "c"]);

    const rows = readCoactivations(database);
    // c (pass 2) paired with each pass-1 hit a and b → two rows.
    expect(rows).toHaveLength(2);
    const pairs = rows.map((r) => `${r.sourceSlug}->${r.targetSlug}`).sort();
    expect(pairs).toEqual(["a->c", "b->c"]);
    for (const r of rows) {
      expect(r.targetSlug).toBe("c");
      expect(r.passGap).toBe(1);
      expect(r.used).toBe(0);
      expect(r.conversationId).toBe("conv-42");
      expect(r.turn).toBe(7);
    }
  });

  test("emits nothing when the flag is off", async () => {
    scriptTwoPass();
    await runRetrievalLoop(makeInput({ passCap: 3, coactivation: false }), {
      db: database,
      conversationId: "conv-42",
      turn: 7,
    });
    expect(readCoactivations(database)).toHaveLength(0);
  });

  test("single-pass selection emits nothing (no later-surfaced target)", async () => {
    lane.scouts = [
      {
        scouts: [scout("hot", ["a"]), scout("sparse", ["b"])],
        sticky: new Set(),
        bypass: new Set(),
      },
    ];
    lane.filter = [{ kept: [], trace: { judged: [], dropped: [] } }];
    lane.walk = [{ pages: new Set(), levels: [] }];
    lane.edges = [{ pulled: new Set(), expansions: [] }];
    lane.gate = [
      { decision: { decision: "ready" }, selectedSlugs: ["a", "b"] },
    ];

    await runRetrievalLoop(makeInput({ passCap: 3, coactivation: true }), {
      db: database,
      conversationId: "conv-1",
      turn: 1,
    });
    expect(readCoactivations(database)).toHaveLength(0);
  });
});
