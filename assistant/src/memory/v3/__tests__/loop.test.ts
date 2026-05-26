/**
 * Tests for `assistant/src/memory/v3/loop.ts`.
 *
 * The loop is the composition layer over the v3 lanes. Every lane module
 * (`scouts`, `filter`, `tree-walk`, `edges`, `gate`) plus the two index
 * builders (`tree-index`, `page-index`) the loop calls are stubbed via
 * `mock.module`, so the suite makes no real LLM, Qdrant, embedding, or
 * filesystem calls. Each mock factory closes over a mutable `lane` state object
 * that every test rewires before calling `runRetrievalLoop`; a `laneCalls`
 * recorder captures the arguments the loop passed each lane so the composition
 * wiring (seeding, query threading, toggles) is assertable.
 *
 * Coverage:
 *   - single-pass ready: scouts → filter → tree → edges → gate composes into a
 *     valid RetrievalOutput with per-lane source tags and one DescentPass.
 *   - multi-pass: gate "more" then "ready" runs two passes and threads the
 *     gate's questions into the second pass's NOW text.
 *   - passCap: a gate that always says "more" force-exits at passCap.
 *   - lane toggles: `lanes.tree=false` / `lanes.edges=false` suppress those
 *     lanes' candidates and trace fields.
 *   - trace: one DescentPass per pass.
 *   - cost: `ms` accumulates and is non-negative across passes.
 *   - failureReason: a filter failure is surfaced on the output.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { DrizzleDb } from "../../db-connection.js";
import type {
  RetrievalInput,
  RetrievalOutput,
} from "../../v2/harness/retriever.js";
import type { GateDecision, ScoutResult } from "../../v2/harness/trace.js";

// ---------------------------------------------------------------------------
// Lane stubs — installed before importing the module under test.
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

/**
 * Per-pass-programmable lane state. The mock factories close over these live
 * refs; each test rewires them before calling `runRetrievalLoop`. List-valued
 * fields are consumed pass-by-pass (one entry per pass) so a multi-pass test
 * can script a different verdict per pass.
 */
const lane = {
  scouts: [] as RunScoutsResult[],
  filter: [] as FilterResult[],
  walk: [] as WalkResult[],
  edges: [] as ExpandResult[],
  gate: [] as GateResult[],
};

/** Records the args the loop passed each lane, one entry per call. */
const laneCalls = {
  scouts: [] as Array<{ nowText: string }>,
  filter: [] as Array<{ nowText: string; dense: ScoutResult }>,
  walk: [] as Array<{
    nowText: string;
    scouts: ScoutResult[];
  }>,
  edges: [] as Array<{ seeds: string[] }>,
  gate: [] as Array<{
    nowText: string;
    passNumber: number;
    candidates: string[];
    sticky: string[];
  }>,
};

/** Pop the next scripted value for a pass, reusing the last entry if exhausted. */
function nextOf<T>(list: T[], index: number): T {
  return list[Math.min(index, list.length - 1)];
}

let scoutCallCount = 0;
let walkCallCount = 0;
let edgeCallCount = 0;
let gateCallCount = 0;

mock.module("../scouts.js", () => ({
  runScouts: async (input: RetrievalInput): Promise<RunScoutsResult> => {
    laneCalls.scouts.push({ nowText: input.nowText });
    return nextOf(lane.scouts, scoutCallCount++);
  },
}));

mock.module("../filter.js", () => ({
  filterDenseHits: async (args: {
    input: RetrievalInput;
    dense: ScoutResult;
  }): Promise<FilterResult> => {
    laneCalls.filter.push({ nowText: args.input.nowText, dense: args.dense });
    // Filter calls share the scout pass index (one filter call per dense pass).
    return nextOf(lane.filter, laneCalls.filter.length - 1);
  },
}));

mock.module("../tree-walk.js", () => ({
  runTreeWalk: async (args: {
    input: RetrievalInput;
    scouts: ScoutResult[];
  }): Promise<WalkResult> => {
    laneCalls.walk.push({
      nowText: args.input.nowText,
      scouts: args.scouts,
    });
    return nextOf(lane.walk, walkCallCount++);
  },
}));

mock.module("../edges.js", () => ({
  expandEdges: async (args: {
    seeds: Iterable<string>;
  }): Promise<ExpandResult> => {
    laneCalls.edges.push({ seeds: [...args.seeds] });
    return nextOf(lane.edges, edgeCallCount++);
  },
}));

mock.module("../gate.js", () => ({
  runGate: async (args: {
    input: RetrievalInput;
    candidates: Set<string>;
    sticky: Set<string>;
    passNumber: number;
  }): Promise<GateResult> => {
    laneCalls.gate.push({
      nowText: args.input.nowText,
      passNumber: args.passNumber,
      candidates: [...args.candidates],
      sticky: [...args.sticky],
    });
    return nextOf(lane.gate, gateCallCount++);
  },
}));

// The loop calls these index builders only to hand opaque handles to the
// (stubbed) tree walk. The stubs return harmless empty values.
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

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/** Opaque DB sentinel — the stubbed scout lane never dereferences it. */
const db = {} as DrizzleDb;

interface LaneConfig {
  hot?: boolean;
  sparse?: boolean;
  dense?: boolean;
  tree?: boolean;
  edges?: boolean;
}

/**
 * Minimal `RetrievalInput`. Only `nowText` and `config.memory.v3` (passCap +
 * lanes) are read by the loop; the lanes are stubbed so the rest is inert.
 */
function makeInput(opts?: {
  nowText?: string;
  passCap?: number;
  lanes?: LaneConfig;
}): RetrievalInput {
  const lanes = {
    hot: true,
    sparse: true,
    dense: true,
    tree: true,
    edges: true,
    ...opts?.lanes,
  };
  return {
    workspaceDir: "/tmp/does-not-matter",
    recentTurnPairs: [],
    nowText: opts?.nowText ?? "NOW",
    priorEverInjected: [],
    config: {
      memory: { v3: { passCap: opts?.passCap ?? 3, lanes } },
    } as unknown as RetrievalInput["config"],
  };
}

function scout(lane: ScoutResult["lane"], slugs: string[]): ScoutResult {
  return { lane, slugs };
}

function readyGate(selected: string[]): GateResult {
  return { decision: { decision: "ready" }, selectedSlugs: selected };
}

function moreGate(selected: string[], questions: string[]): GateResult {
  return { decision: { decision: "more", questions }, selectedSlugs: selected };
}

function reset(): void {
  lane.scouts = [];
  lane.filter = [];
  lane.walk = [];
  lane.edges = [];
  lane.gate = [];
  laneCalls.scouts = [];
  laneCalls.filter = [];
  laneCalls.walk = [];
  laneCalls.edges = [];
  laneCalls.gate = [];
  scoutCallCount = 0;
  walkCallCount = 0;
  edgeCallCount = 0;
  gateCallCount = 0;
}

beforeEach(reset);

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("runRetrievalLoop — single pass", () => {
  test("ready path composes a valid RetrievalOutput with per-lane source tags", async () => {
    lane.scouts = [
      {
        scouts: [
          scout("hot", ["a"]),
          scout("sparse", ["b"]),
          scout("dense", ["c", "d"]),
        ],
        sticky: new Set(["a", "b"]),
        bypass: new Set(["b"]),
      },
    ];
    lane.filter = [{ kept: ["c"], trace: { judged: ["d"], dropped: ["d"] } }];
    lane.walk = [
      {
        pages: new Set(["t1"]),
        levels: [
          {
            node: "_root",
            considered: ["sub"],
            descended: ["sub"],
            skipped: [],
            reasoning: "r",
          },
        ],
      },
    ];
    lane.edges = [
      { pulled: new Set(["e1"]), expansions: [{ from: "a", pulled: ["e1"] }] },
    ];
    lane.gate = [readyGate(["a", "b", "c", "t1", "e1"])];

    const out: RetrievalOutput = await runRetrievalLoop(makeInput(), { db });

    expect(out.selectedSlugs).toEqual(["a", "b", "c", "t1", "e1"]);
    // sourceBySlug tags each slug with the lane that first surfaced it.
    expect(out.sourceBySlug.get("a")).toBe("hot");
    expect(out.sourceBySlug.get("b")).toBe("sparse");
    expect(out.sourceBySlug.get("c")).toBe("dense");
    expect(out.sourceBySlug.get("t1")).toBe("tree");
    expect(out.sourceBySlug.get("e1")).toBe("edge");
    // Dropped dense candidate `d` was filtered out — never tagged.
    expect(out.sourceBySlug.has("d")).toBe(false);

    // Exactly one pass, with all four lane sub-traces present.
    expect(out.trace?.passes).toHaveLength(1);
    const pass = out.trace!.passes[0];
    expect(pass.passNumber).toBe(1);
    expect(pass.scouts).toHaveLength(3);
    expect(pass.treeLevels).toHaveLength(1);
    expect(pass.edgeExpansions).toHaveLength(1);
    expect(pass.gate).toEqual({ decision: "ready" });

    expect(out.failureReason).toBeNull();
    expect(out.cost?.ms).toBeGreaterThanOrEqual(0);
  });

  test("dense lane is filtered before seeding tree + gate", async () => {
    lane.scouts = [
      {
        scouts: [scout("dense", ["keep", "drop"])],
        sticky: new Set(),
        bypass: new Set(),
      },
    ];
    lane.filter = [
      {
        kept: ["keep"],
        trace: { judged: ["keep", "drop"], dropped: ["drop"] },
      },
    ];
    lane.walk = [{ pages: new Set(), levels: [] }];
    lane.edges = [{ pulled: new Set(), expansions: [] }];
    lane.gate = [readyGate(["keep"])];

    const out = await runRetrievalLoop(makeInput(), { db });

    // The filter saw the full dense lane.
    expect(laneCalls.filter[0].dense.slugs).toEqual(["keep", "drop"]);
    // The dropped dense slug never reaches the gate's candidate set.
    expect(laneCalls.gate[0].candidates).toEqual(["keep"]);
    expect(out.selectedSlugs).toEqual(["keep"]);
  });
});

describe("runRetrievalLoop — multi pass", () => {
  test("gate 'more' then 'ready' runs two passes and threads questions into NOW", async () => {
    lane.scouts = [
      {
        scouts: [scout("dense", ["p1"])],
        sticky: new Set(),
        bypass: new Set(),
      },
      {
        scouts: [scout("dense", ["p2"])],
        sticky: new Set(),
        bypass: new Set(),
      },
    ];
    lane.filter = [
      { kept: ["p1"], trace: { judged: ["p1"], dropped: [] } },
      { kept: ["p2"], trace: { judged: ["p2"], dropped: [] } },
    ];
    lane.walk = [
      { pages: new Set(), levels: [] },
      { pages: new Set(), levels: [] },
    ];
    lane.edges = [
      { pulled: new Set(), expansions: [] },
      { pulled: new Set(), expansions: [] },
    ];
    lane.gate = [moreGate(["p1"], ["what about X?"]), readyGate(["p1", "p2"])];

    const out = await runRetrievalLoop(
      makeInput({ nowText: "BASE", passCap: 3 }),
      { db },
    );

    // Two passes ran.
    expect(out.trace?.passes).toHaveLength(2);
    expect(out.trace!.passes[0].gate).toEqual({
      decision: "more",
      questions: ["what about X?"],
    });
    expect(out.trace!.passes[1].gate).toEqual({ decision: "ready" });

    // Pass 1 used the base NOW verbatim; pass 2's NOW carried the gate's
    // generated follow-up question — the standing context is not rewritten.
    expect(laneCalls.scouts[0].nowText).toBe("BASE");
    expect(laneCalls.scouts[1].nowText).toContain("BASE");
    expect(laneCalls.scouts[1].nowText).toContain("what about X?");

    // Final selection is the last (ready) pass's selection.
    expect(out.selectedSlugs).toEqual(["p1", "p2"]);
  });

  test("candidates accumulate across passes so the final gate sees pass-1 hits", async () => {
    // Each pass surfaces a distinct dense hit. Without cross-pass accumulation
    // the pass-2 gate would only see "p2"; with it, the cumulative pool carries
    // pass-1's "p1" into the final gate input.
    lane.scouts = [
      {
        scouts: [scout("dense", ["p1"])],
        sticky: new Set(),
        bypass: new Set(),
      },
      {
        scouts: [scout("dense", ["p2"])],
        sticky: new Set(),
        bypass: new Set(),
      },
    ];
    lane.filter = [
      { kept: ["p1"], trace: { judged: ["p1"], dropped: [] } },
      { kept: ["p2"], trace: { judged: ["p2"], dropped: [] } },
    ];
    lane.walk = [
      { pages: new Set(), levels: [] },
      { pages: new Set(), levels: [] },
    ];
    lane.edges = [
      { pulled: new Set(), expansions: [] },
      { pulled: new Set(), expansions: [] },
    ];
    lane.gate = [moreGate(["p1"], ["more?"]), readyGate(["p1", "p2"])];

    const out = await runRetrievalLoop(makeInput({ passCap: 3 }), { db });

    // Pass 1's gate saw only p1; pass 2's gate saw the cumulative pool.
    expect(laneCalls.gate[0].candidates).toEqual(["p1"]);
    expect(laneCalls.gate[1].candidates).toEqual(
      expect.arrayContaining(["p1", "p2"]),
    );
    expect(out.selectedSlugs).toEqual(["p1", "p2"]);
  });

  test("passCap force-exits with the current selection when the gate keeps asking for more", async () => {
    lane.scouts = [
      { scouts: [scout("dense", ["p"])], sticky: new Set(), bypass: new Set() },
    ];
    lane.filter = [{ kept: ["p"], trace: { judged: ["p"], dropped: [] } }];
    lane.walk = [{ pages: new Set(), levels: [] }];
    lane.edges = [{ pulled: new Set(), expansions: [] }];
    // Gate always says "more"; reused across every pass via nextOf.
    lane.gate = [moreGate(["p"], ["again?"])];

    const out = await runRetrievalLoop(makeInput({ passCap: 2 }), { db });

    // Capped at passCap passes despite the gate never saying ready.
    expect(out.trace?.passes).toHaveLength(2);
    expect(gateCallCount).toBe(2);
    expect(out.selectedSlugs).toEqual(["p"]);
  });
});

describe("runRetrievalLoop — lane toggles", () => {
  test("tree + edge lanes off removes their candidates and trace fields", async () => {
    lane.scouts = [
      { scouts: [scout("dense", ["s"])], sticky: new Set(), bypass: new Set() },
    ];
    lane.filter = [{ kept: ["s"], trace: { judged: ["s"], dropped: [] } }];
    // These would contribute t1/e1 if their lanes ran — they must not.
    lane.walk = [
      {
        pages: new Set(["t1"]),
        levels: [
          {
            node: "_root",
            considered: [],
            descended: [],
            skipped: [],
            reasoning: "",
          },
        ],
      },
    ];
    lane.edges = [
      { pulled: new Set(["e1"]), expansions: [{ from: "s", pulled: ["e1"] }] },
    ];
    lane.gate = [readyGate(["s"])];

    const out = await runRetrievalLoop(
      makeInput({ lanes: { tree: false, edges: false } }),
      { db },
    );

    // Disabled lanes were never called.
    expect(laneCalls.walk).toHaveLength(0);
    expect(laneCalls.edges).toHaveLength(0);
    // Their would-be candidates never entered the gate or the selection.
    expect(laneCalls.gate[0].candidates).toEqual(["s"]);
    expect(out.sourceBySlug.has("t1")).toBe(false);
    expect(out.sourceBySlug.has("e1")).toBe(false);
    // Trace omits the disabled lanes' fields.
    expect(out.trace!.passes[0].treeLevels).toBeUndefined();
    expect(out.trace!.passes[0].edgeExpansions).toBeUndefined();
  });

  test("edge lane on by default expands over the accumulated candidate set", async () => {
    lane.scouts = [
      {
        scouts: [scout("hot", ["h"]), scout("dense", ["d"])],
        sticky: new Set(["h"]),
        bypass: new Set(),
      },
    ];
    lane.filter = [{ kept: ["d"], trace: { judged: ["d"], dropped: [] } }];
    lane.walk = [{ pages: new Set(["t"]), levels: [] }];
    lane.edges = [
      { pulled: new Set(["x"]), expansions: [{ from: "d", pulled: ["x"] }] },
    ];
    lane.gate = [readyGate(["h", "d", "t", "x"])];

    await runRetrievalLoop(makeInput(), { db });

    // Edge expansion seeds over every accumulated confident slug (hot, dense,
    // tree) — not just the scouts.
    expect(laneCalls.edges[0].seeds).toEqual(
      expect.arrayContaining(["h", "d", "t"]),
    );
  });
});

describe("runRetrievalLoop — failure + cost", () => {
  test("surfaces a filter failureReason on the output", async () => {
    lane.scouts = [
      { scouts: [scout("dense", ["d"])], sticky: new Set(), bypass: new Set() },
    ];
    lane.filter = [
      {
        kept: ["d"],
        trace: { judged: ["d"], dropped: [] },
        failureReason: "no_provider",
      },
    ];
    lane.walk = [{ pages: new Set(), levels: [] }];
    lane.edges = [{ pulled: new Set(), expansions: [] }];
    lane.gate = [readyGate(["d"])];

    const out = await runRetrievalLoop(makeInput(), { db });

    expect(out.failureReason).toBe("no_provider");
  });

  test("cost.ms accumulates across passes", async () => {
    lane.scouts = [
      { scouts: [scout("dense", ["p"])], sticky: new Set(), bypass: new Set() },
    ];
    lane.filter = [{ kept: ["p"], trace: { judged: ["p"], dropped: [] } }];
    lane.walk = [{ pages: new Set(), levels: [] }];
    lane.edges = [{ pulled: new Set(), expansions: [] }];
    lane.gate = [moreGate(["p"], ["q"])];

    const out = await runRetrievalLoop(makeInput({ passCap: 3 }), { db });

    expect(out.trace?.passes).toHaveLength(3);
    expect(out.cost?.ms).toBeGreaterThanOrEqual(0);
  });
});
