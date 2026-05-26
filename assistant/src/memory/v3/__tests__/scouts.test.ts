/**
 * Tests for `assistant/src/memory/v3/scouts.ts`.
 *
 * The scout lanes read the v2 substrate (page index, injection-event EMA,
 * Qdrant hybrid query, BM25, dense embed + calibration). Every one of those is
 * stubbed via `mock.module` so the suite needs no real Qdrant, embedding
 * backend, or LLM — and the SQLite-backed EMA is replaced by a hand-fed score
 * map, so the injected `db` is an opaque sentinel the lane never dereferences.
 *
 * Coverage:
 *   - hot lane: ranks the EMA score map desc, marks every hit sticky.
 *   - sparse lane: reads sparseScore, ranks desc, flags near-exact hits
 *     sticky + tree-bypass.
 *   - dense lane: per-subtree quota caps off-domain hits; MMR diversifies.
 *   - lane toggles: each disabled lane is fully suppressed (no ScoutResult).
 *   - empty query / empty corpus short-circuits.
 *   - honors AbortSignal.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { PageIndex } from "../../v2/page-index.js";
import type { ConceptPageQueryResult } from "../../v2/qdrant.js";

// ---------------------------------------------------------------------------
// Substrate stubs — installed before importing the module under test.
// ---------------------------------------------------------------------------

// Per-call programmable substrate state. Each test rewires these before
// calling runScouts; the mock factories below close over the live refs.
let injectionScores = new Map<string, number>();
let pageSlugs: string[] = [];
let hybridHits: ConceptPageQueryResult[] = [];
let embedCalls = 0;

mock.module("../../v2/injection-events.js", () => ({
  computeInjectionScores: () => injectionScores,
}));

mock.module("../../v2/page-index.js", () => ({
  getPageIndex: async (): Promise<PageIndex> => ({
    entries: pageSlugs.map((slug, i) => ({
      id: i + 1,
      slug,
      summary: "",
      edges: [],
      modifiedAt: 0,
    })),
    bySlug: new Map(),
    byId: new Map(),
    rendered: "",
  }),
}));

mock.module("../../v2/qdrant.js", () => ({
  hybridQueryConceptPages: async (): Promise<ConceptPageQueryResult[]> =>
    hybridHits,
}));

mock.module("../../v2/sparse-bm25.js", () => ({
  // Non-empty indices so the sparse/dense lanes don't short-circuit on an
  // "empty query embedding". The values are irrelevant — the stubbed Qdrant
  // query ignores them and returns `hybridHits` directly.
  generateBm25QueryEmbedding: (text: string) =>
    text.trim().length > 0
      ? { indices: [1], values: [1] }
      : { indices: [], values: [] },
}));

mock.module("../../embedding-backend.js", () => ({
  embedWithBackend: async () => {
    embedCalls += 1;
    return { provider: "local", model: "stub", vectors: [[0.1, 0.2, 0.3]] };
  },
}));

mock.module("../../anisotropy.js", () => ({
  applyCorrectionIfCalibrated: async (vec: number[]) => vec,
}));

const { runScouts } = await import("../scouts.js");
import type { RetrievalInput } from "../../v2/harness/retriever.js";
import type { ScoutDeps } from "../scouts.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DB_SENTINEL = { __opaque: true } as unknown as ScoutDeps["db"];
const DEPS: ScoutDeps = { db: DB_SENTINEL };

type Lanes = { hot: boolean; sparse: boolean; dense: boolean };

function makeInput(opts?: {
  userMessage?: string;
  nowText?: string;
  lanes?: Partial<Lanes>;
  denseQuota?: { activeDomain: number; offDomain: number };
  hotLimit?: number;
  signal?: AbortSignal;
}): RetrievalInput {
  const lanes = {
    hot: true,
    sparse: true,
    dense: true,
    tree: true,
    edges: true,
    ...opts?.lanes,
  };
  const config = {
    memory: {
      v3: {
        lanes,
        denseQuota: opts?.denseQuota ?? { activeDomain: 30, offDomain: 8 },
        hotLimit: opts?.hotLimit ?? 50,
      },
    },
  } as unknown as RetrievalInput["config"];
  return {
    workspaceDir: "/tmp/ws",
    recentTurnPairs: [
      { assistantMessage: "", userMessage: opts?.userMessage ?? "tell me" },
    ],
    nowText: opts?.nowText ?? "now context",
    priorEverInjected: [],
    config,
    signal: opts?.signal,
  };
}

function hit(
  slug: string,
  scores: Partial<ConceptPageQueryResult>,
): ConceptPageQueryResult {
  return { slug, ...scores };
}

beforeEach(() => {
  injectionScores = new Map();
  pageSlugs = [];
  hybridHits = [];
  embedCalls = 0;
});

// ---------------------------------------------------------------------------
// Hot lane
// ---------------------------------------------------------------------------

describe("runScouts — hot lane", () => {
  test("ranks EMA scores desc and marks every hit sticky", async () => {
    pageSlugs = ["people/alice", "work/proj", "essentials"];
    injectionScores = new Map([
      ["work/proj", 0.2],
      ["people/alice", 0.9],
    ]);

    const { scouts, sticky } = await runScouts(
      makeInput({ lanes: { sparse: false, dense: false } }),
      DEPS,
    );

    const hot = scouts.find((s) => s.lane === "hot");
    expect(hot?.slugs).toEqual(["people/alice", "work/proj"]);
    expect(hot?.scoreBySlug).toEqual({ "people/alice": 0.9, "work/proj": 0.2 });
    expect([...sticky].sort()).toEqual(["people/alice", "work/proj"]);
  });

  test("caps the hot lane to the top hotLimit by EMA", async () => {
    pageSlugs = ["a", "b", "c", "d"];
    injectionScores = new Map([
      ["a", 0.9],
      ["b", 0.7],
      ["c", 0.5],
      ["d", 0.3],
    ]);

    const { scouts, sticky } = await runScouts(
      makeInput({ lanes: { sparse: false, dense: false }, hotLimit: 2 }),
      DEPS,
    );

    // Only the top-2 by EMA survive the cap; the long tail is dropped so it
    // can't flood the (sticky) candidate set on a mature corpus.
    const hot = scouts.find((s) => s.lane === "hot");
    expect(hot?.slugs).toEqual(["a", "b"]);
    expect(hot?.scoreBySlug).toEqual({ a: 0.9, b: 0.7 });
    expect([...sticky].sort()).toEqual(["a", "b"]);
  });

  test("empty corpus yields no hot ScoutResult", async () => {
    pageSlugs = [];
    const { scouts } = await runScouts(
      makeInput({ lanes: { sparse: false, dense: false } }),
      DEPS,
    );
    expect(scouts.find((s) => s.lane === "hot")).toBeUndefined();
  });

  test("no EMA events yields no hot ScoutResult", async () => {
    pageSlugs = ["a", "b"];
    injectionScores = new Map();
    const { scouts, sticky } = await runScouts(
      makeInput({ lanes: { sparse: false, dense: false } }),
      DEPS,
    );
    expect(scouts.find((s) => s.lane === "hot")).toBeUndefined();
    expect(sticky.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sparse lane
// ---------------------------------------------------------------------------

describe("runScouts — sparse lane", () => {
  test("reads sparseScore, ranks desc, flags near-exact sticky + bypass", async () => {
    hybridHits = [
      hit("docs/readme", { sparseScore: 4.0 }),
      hit("docs/api", { sparseScore: 3.9 }), // within 90% of top -> near-exact
      hit("misc/note", { sparseScore: 1.0 }), // below threshold
      hit("dense/only", { denseScore: 0.8 }), // no sparseScore -> dropped
    ];

    const { scouts, sticky, bypass } = await runScouts(
      makeInput({ lanes: { hot: false, dense: false } }),
      DEPS,
    );

    const sparse = scouts.find((s) => s.lane === "sparse");
    expect(sparse?.slugs).toEqual(["docs/readme", "docs/api", "misc/note"]);
    // Near-exact: readme (top) and api (>= 90% of top). Not misc/note.
    expect([...sticky].sort()).toEqual(["docs/api", "docs/readme"]);
    expect([...bypass].sort()).toEqual(["docs/api", "docs/readme"]);
  });

  test("no sparse hits yields no sparse ScoutResult", async () => {
    hybridHits = [hit("dense/only", { denseScore: 0.5 })];
    const { scouts, sticky, bypass } = await runScouts(
      makeInput({ lanes: { hot: false, dense: false } }),
      DEPS,
    );
    expect(scouts.find((s) => s.lane === "sparse")).toBeUndefined();
    expect(sticky.size).toBe(0);
    expect(bypass.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dense lane
// ---------------------------------------------------------------------------

describe("runScouts — dense lane", () => {
  test("embeds the query and emits dense hits ranked by denseScore", async () => {
    hybridHits = [
      hit("work/a", { denseScore: 0.9 }),
      hit("work/b", { denseScore: 0.7 }),
    ];
    const { scouts } = await runScouts(
      makeInput({ lanes: { hot: false, sparse: false } }),
      DEPS,
    );
    expect(embedCalls).toBe(1);
    const dense = scouts.find((s) => s.lane === "dense");
    expect(dense?.slugs[0]).toBe("work/a");
    expect(dense?.scoreBySlug).toEqual({ "work/a": 0.9, "work/b": 0.7 });
  });

  test("per-subtree quota caps off-domain hits", async () => {
    // Active domain = top hit's domain = "work". Off-domain quota = 1.
    hybridHits = [
      hit("work/a", { denseScore: 0.99 }),
      hit("work/b", { denseScore: 0.98 }),
      hit("work/c", { denseScore: 0.97 }),
      hit("people/x", { denseScore: 0.5 }), // off-domain, claims the 1 slot
      hit("notes/y", { denseScore: 0.4 }), // off-domain, over quota -> dropped
      hit("misc/z", { denseScore: 0.3 }), // off-domain, over quota -> dropped
    ];
    const { scouts } = await runScouts(
      makeInput({
        lanes: { hot: false, sparse: false },
        denseQuota: { activeDomain: 30, offDomain: 1 },
      }),
      DEPS,
    );
    const dense = scouts.find((s) => s.lane === "dense");
    const slugs = dense?.slugs ?? [];
    // All three work/* survive (active quota 30); exactly one off-domain hit.
    expect(slugs.filter((s) => s.startsWith("work/")).length).toBe(3);
    const offDomain = slugs.filter((s) => !s.startsWith("work/"));
    expect(offDomain).toEqual(["people/x"]);
  });

  test("active-domain quota caps same-subtree hits", async () => {
    hybridHits = [
      hit("work/a", { denseScore: 0.99 }),
      hit("work/b", { denseScore: 0.98 }),
      hit("work/c", { denseScore: 0.97 }), // over active quota 2 -> dropped
      hit("people/x", { denseScore: 0.5 }),
    ];
    const { scouts } = await runScouts(
      makeInput({
        lanes: { hot: false, sparse: false },
        denseQuota: { activeDomain: 2, offDomain: 8 },
      }),
      DEPS,
    );
    const slugs = scouts.find((s) => s.lane === "dense")?.slugs ?? [];
    expect(slugs.filter((s) => s.startsWith("work/")).length).toBe(2);
    expect(slugs).toContain("people/x");
  });

  test("MMR interleaves subtrees rather than emitting a same-subtree run", async () => {
    // Five work/* then one people/* of comparable relevance. Pure score order
    // would bury people/x last; MMR should pull it forward once work/ is
    // over-represented.
    hybridHits = [
      hit("work/a", { denseScore: 0.95 }),
      hit("work/b", { denseScore: 0.94 }),
      hit("work/c", { denseScore: 0.93 }),
      hit("work/d", { denseScore: 0.92 }),
      hit("people/x", { denseScore: 0.9 }),
    ];
    const { scouts } = await runScouts(
      makeInput({
        lanes: { hot: false, sparse: false },
        denseQuota: { activeDomain: 30, offDomain: 8 },
      }),
      DEPS,
    );
    const slugs = scouts.find((s) => s.lane === "dense")?.slugs ?? [];
    // people/x is not stranded at the very end despite the lowest raw score.
    expect(slugs.indexOf("people/x")).toBeLessThan(slugs.length - 1);
  });

  test("no dense hits yields no dense ScoutResult", async () => {
    hybridHits = [hit("sparse/only", { sparseScore: 2.0 })];
    const { scouts } = await runScouts(
      makeInput({ lanes: { hot: false, sparse: false } }),
      DEPS,
    );
    expect(scouts.find((s) => s.lane === "dense")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Lane toggles
// ---------------------------------------------------------------------------

describe("runScouts — lane toggles", () => {
  test("disabling a lane suppresses its ScoutResult", async () => {
    pageSlugs = ["a"];
    injectionScores = new Map([["a", 1]]);
    hybridHits = [hit("docs/a", { sparseScore: 2.0, denseScore: 0.5 })];

    const all = await runScouts(makeInput(), DEPS);
    expect(all.scouts.map((s) => s.lane).sort()).toEqual([
      "dense",
      "hot",
      "sparse",
    ]);

    const hotOnly = await runScouts(
      makeInput({ lanes: { sparse: false, dense: false } }),
      DEPS,
    );
    expect(hotOnly.scouts.map((s) => s.lane)).toEqual(["hot"]);
    // Dense embed must not run when the dense lane is off.
    embedCalls = 0;
    await runScouts(makeInput({ lanes: { dense: false } }), DEPS);
    expect(embedCalls).toBe(0);
  });

  test("all lanes off yields empty result", async () => {
    pageSlugs = ["a"];
    injectionScores = new Map([["a", 1]]);
    hybridHits = [hit("docs/a", { sparseScore: 2.0, denseScore: 0.5 })];
    const { scouts, sticky, bypass } = await runScouts(
      makeInput({ lanes: { hot: false, sparse: false, dense: false } }),
      DEPS,
    );
    expect(scouts).toEqual([]);
    expect(sticky.size).toBe(0);
    expect(bypass.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

describe("runScouts — misc", () => {
  test("empty query text skips sparse and dense lanes", async () => {
    pageSlugs = ["a"];
    injectionScores = new Map([["a", 1]]);
    hybridHits = [hit("docs/a", { sparseScore: 2.0, denseScore: 0.5 })];
    const { scouts } = await runScouts(
      makeInput({ userMessage: "   ", nowText: "  " }),
      DEPS,
    );
    // Hot lane is query-independent and still fires; sparse/dense are gated off.
    expect(scouts.map((s) => s.lane)).toEqual(["hot"]);
    expect(embedCalls).toBe(0);
  });

  test("honors an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    pageSlugs = ["a"];
    injectionScores = new Map([["a", 1]]);
    await expect(
      runScouts(makeInput({ signal: controller.signal }), DEPS),
    ).rejects.toThrow();
  });
});
