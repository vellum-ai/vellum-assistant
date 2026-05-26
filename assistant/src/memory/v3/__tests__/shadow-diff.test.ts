import { describe, expect, test } from "bun:test";

import type { MemoryV2ConceptRowRecord } from "../../memory-v2-activation-log-store.js";
import { computeShadowDiff, type ShadowDiffLogRow } from "../shadow-diff.js";

const ZERO = {
  finalActivation: 0,
  ownActivation: 0,
  priorActivation: 0,
  simUser: 0,
  simAssistant: 0,
  simNow: 0,
  simUserRerankBoost: 0,
  simAssistantRerankBoost: 0,
  inRerankPool: false,
  spreadContribution: 0,
} as const;

/** A v2 router concept row with the given selection status. */
function v2concept(
  slug: string,
  status: MemoryV2ConceptRowRecord["status"],
): MemoryV2ConceptRowRecord {
  return { slug, status, source: "tier3:0", ...ZERO };
}

/** A v3 shadow concept row (always status 'injected') tagged with its lane. */
function v3concept(slug: string, lane: string): MemoryV2ConceptRowRecord {
  return { slug, status: "injected", source: "router", lane, ...ZERO };
}

function shadowRow(
  conversationId: string,
  createdAt: number,
  slugLanes: Array<[string, string]>,
): ShadowDiffLogRow {
  return {
    conversationId,
    createdAt,
    concepts: slugLanes.map(([slug, lane]) => v3concept(slug, lane)),
  };
}

function routerRow(
  conversationId: string,
  createdAt: number,
  opts: { injected?: string[]; cached?: string[]; rejected?: string[] },
): ShadowDiffLogRow {
  return {
    conversationId,
    createdAt,
    concepts: [
      ...(opts.injected ?? []).map((s) => v2concept(s, "injected")),
      ...(opts.cached ?? []).map((s) => v2concept(s, "in_context")),
      ...(opts.rejected ?? []).map((s) => v2concept(s, "not_injected")),
    ],
  };
}

const OPTS = { toleranceMs: 10_000, detailLimit: 50 };

describe("computeShadowDiff", () => {
  test("pairs nearest router row and diffs fresh-injected vs shadow sets", () => {
    const shadow = [
      shadowRow("conv1", 1000, [
        ["a", "tree"],
        ["b", "edge"],
        ["c", "hot"],
      ]),
    ];
    const router = [
      routerRow("conv1", 1500, {
        injected: ["a", "b", "x", "y"],
        cached: ["cached1", "cached2"],
        rejected: ["rej1"],
      }),
    ];

    const result = computeShadowDiff(shadow, router, OPTS);

    expect(result.turnsCompared).toBe(1);
    expect(result.unpaired).toHaveLength(0);

    const turn = result.turns[0]!;
    expect(turn.deltaMs).toBe(500);
    expect(turn.v2Count).toBe(4);
    expect(turn.v3Count).toBe(3);
    expect(turn.v2CachedCount).toBe(2);
    expect(turn.overlap).toEqual(["a", "b"]);
    expect(turn.v3Only).toEqual(["c"]);
    expect(turn.v2Only).toEqual(["x", "y"]);
    // cached / rejected v2 rows are NOT counted as dropped picks.
    expect(turn.v2Only).not.toContain("cached1");
    expect(turn.v2Only).not.toContain("rej1");
    expect(turn.jaccard).toBeCloseTo(2 / 5, 10);
  });

  test("attributes overlap and v3-only to the v3 provenance lane", () => {
    const shadow = [
      shadowRow("conv1", 1000, [
        ["a", "tree"],
        ["b", "edge"],
        ["c", "hot"],
      ]),
    ];
    const router = [routerRow("conv1", 1100, { injected: ["a", "b"] })];

    const { agg } = computeShadowDiff(shadow, router, OPTS);

    expect(agg.overlapByLane).toEqual({ tree: 1, edge: 1 });
    expect(agg.v3OnlyByLane).toEqual({ hot: 1 });
  });

  test("defaults a missing lane to 'unknown'", () => {
    const shadow: ShadowDiffLogRow[] = [
      {
        conversationId: "conv1",
        createdAt: 1000,
        concepts: [
          { slug: "a", status: "injected", source: "router", ...ZERO },
        ],
      },
    ];
    const router = [routerRow("conv1", 1100, { injected: [] })];

    const { agg } = computeShadowDiff(shadow, router, OPTS);

    expect(agg.v3OnlyByLane).toEqual({ unknown: 1 });
  });

  test("sends a shadow row with no router row within tolerance to unpaired", () => {
    const shadow = [shadowRow("conv1", 1000, [["a", "tree"]])];
    const router = [routerRow("conv1", 1000 + 20_000, { injected: ["a"] })];

    const result = computeShadowDiff(shadow, router, OPTS);

    expect(result.turnsCompared).toBe(0);
    expect(result.unpaired).toEqual([
      { conversationId: "conv1", shadowAt: 1000, v3Count: 1 },
    ]);
  });

  test("greedily pairs each router row to at most one shadow row", () => {
    const shadow = [
      shadowRow("conv1", 1000, [["a", "tree"]]),
      shadowRow("conv1", 5000, [["b", "edge"]]),
    ];
    const router = [
      routerRow("conv1", 1200, { injected: ["a", "z"] }),
      routerRow("conv1", 5200, { injected: ["b"] }),
    ];

    const result = computeShadowDiff(shadow, router, OPTS);

    expect(result.turnsCompared).toBe(2);
    const byShadow = new Map(result.turns.map((t) => [t.shadowAt, t]));
    expect(byShadow.get(1000)!.routerAt).toBe(1200);
    expect(byShadow.get(1000)!.v2Only).toEqual(["z"]);
    expect(byShadow.get(5000)!.routerAt).toBe(5200);
    expect(byShadow.get(5000)!.overlap).toEqual(["b"]);
  });

  test("caps per-turn detail newest-first but aggregates over all turns", () => {
    const shadow = [
      shadowRow("c1", 1000, [["a", "tree"]]),
      shadowRow("c2", 2000, [["b", "tree"]]),
      shadowRow("c3", 3000, [["c", "tree"]]),
    ];
    const router = [
      routerRow("c1", 1000, { injected: ["a"] }),
      routerRow("c2", 2000, { injected: ["b"] }),
      routerRow("c3", 3000, { injected: ["c"] }),
    ];

    const result = computeShadowDiff(shadow, router, {
      toleranceMs: 10_000,
      detailLimit: 2,
    });

    expect(result.turnsCompared).toBe(3);
    expect(result.turns.map((t) => t.shadowAt)).toEqual([3000, 2000]);
  });

  test("ranks the most-dropped and most-added slugs across turns", () => {
    const shadow = [
      shadowRow("c1", 1000, [["extra", "edge"]]),
      shadowRow("c2", 2000, [["extra", "edge"]]),
    ];
    const router = [
      routerRow("c1", 1000, { injected: ["dropped", "kept"] }),
      routerRow("c2", 2000, { injected: ["dropped"] }),
    ];

    const { agg } = computeShadowDiff(shadow, router, OPTS);

    expect(agg.totalV3Only).toBe(2);
    expect(agg.totalV2Only).toBe(3);
    expect(agg.v3OnlyTop[0]).toEqual({ slug: "extra", count: 2 });
    expect(agg.v2OnlyTop[0]).toEqual({ slug: "dropped", count: 2 });
    expect(agg.meanV3).toBeCloseTo(1, 10);
    expect(agg.meanV2).toBeCloseTo(1.5, 10);
  });

  test("returns zeroed aggregates with no rows", () => {
    const result = computeShadowDiff([], [], OPTS);
    expect(result.turnsCompared).toBe(0);
    expect(result.shadowRows).toBe(0);
    expect(result.agg.meanJaccard).toBe(0);
    expect(result.agg.v2OnlyTop).toEqual([]);
    expect(result.turns).toEqual([]);
  });

  test("treats two empty selections as jaccard 0, not NaN", () => {
    const shadow: ShadowDiffLogRow[] = [
      { conversationId: "c1", createdAt: 1000, concepts: [] },
    ];
    const router = [routerRow("c1", 1000, { cached: ["only-cached"] })];

    const result = computeShadowDiff(shadow, router, OPTS);

    expect(result.turnsCompared).toBe(1);
    expect(result.turns[0]!.jaccard).toBe(0);
    expect(result.turns[0]!.v2CachedCount).toBe(1);
  });
});
