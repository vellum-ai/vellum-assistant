/**
 * Tests for `memory/v2/activation.ts` — per-turn activation update.
 *
 * Coverage:
 *   - `selectCandidates`: union of (above-epsilon prior state) ∪ (ANN top-50);
 *      empty turn text skips ANN; empty everywhere returns empty set.
 *   - `computeOwnActivation`: applies `A_o = d·prev + c_user·simU + c_a·simA +
 *      c_now·simN`; clamps to [0,1]; orphan in candidates returns 0 when no
 *      sim hits.
 *   - `spreadActivation`: orphan yields A == A_o; spread walks incoming edges
 *      only (A→B boosts B but not A); hops=2 reaches second-degree predecessors
 *      but not third; bounded in [0,1].
 *   - `selectInjections`: top-K rank, deterministic tie-break, delta against
 *      `everInjected`.
 *
 * Hermetic by design: the embedding backend, qdrant client, and `getConfig`
 * are mocked at the module level so the suite never starts a real backend.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";
import type { AssistantConfig } from "../../../config/types.js";

// ---------------------------------------------------------------------------
// Module-level mocks (registered before `await import("../activation.js")`).
// ---------------------------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

const STUB_QDRANT_CONFIG = {
  memory: {
    qdrant: {
      url: "http://127.0.0.1:6333",
      vectorSize: 384,
      onDisk: true,
    },
  },
};
mock.module("../../../config/loader.js", () => ({
  getConfig: () => STUB_QDRANT_CONFIG,
  loadConfig: () => STUB_QDRANT_CONFIG,
}));

const realQdrantClient = await import("../../qdrant-client.js");
mock.module("../../qdrant-client.js", () => ({
  ...realQdrantClient,
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

const state = {
  embedCalls: [] as Array<{ inputs: unknown[] }>,
  sparseCalls: [] as string[],
  embedReturn: [[0.1, 0.2, 0.3]] as number[][],
  sparseReturn: { indices: [1, 2, 3], values: [0.5, 0.5, 0.5] },
  /**
   * Programmable Qdrant query response queues — one per channel. Each test
   * stages whatever ordered hits it needs and lets `simBatch` /
   * `selectCandidates` drain them.
   */
  queryResponses: {
    dense: [] as Array<{
      points: Array<{ score?: number; payload: Record<string, unknown> }>;
    }>,
    sparse: [] as Array<{
      points: Array<{ score?: number; payload: Record<string, unknown> }>;
    }>,
  },
  // Separate response queue for the dedicated `memory_v2_skills` collection
  // so a test asserting on skill activation does not have to interleave
  // responses with concept-page queries.
  skillQueryResponses: {
    dense: [] as Array<{
      points: Array<{ score?: number; payload: Record<string, unknown> }>;
    }>,
    sparse: [] as Array<{
      points: Array<{ score?: number; payload: Record<string, unknown> }>;
    }>,
  },
  queryCalls: [] as Array<{
    collection: string;
    using: string;
    limit: number;
    filter: unknown;
  }>,
};

const realEmbeddingBackend = await import("../../embedding-backend.js");
mock.module("../../embedding-backend.js", () => ({
  ...realEmbeddingBackend,
  embedWithBackend: async (_config: AssistantConfig, inputs: unknown[]) => {
    state.embedCalls.push({ inputs });
    return {
      provider: "local",
      model: "test-model",
      vectors: state.embedReturn,
    };
  },
  generateSparseEmbedding: (text: string) => {
    state.sparseCalls.push(text);
    return state.sparseReturn;
  },
}));

class MockQdrantClient {
  constructor(_opts: unknown) {}
  async collectionExists(_name: string) {
    return { exists: true };
  }
  async createCollection() {
    return {};
  }
  async createPayloadIndex() {
    return {};
  }
  async query(
    name: string,
    params: { using: string; limit: number; filter?: unknown },
  ) {
    state.queryCalls.push({
      collection: name,
      using: params.using,
      limit: params.limit,
      filter: params.filter,
    });
    const channel = params.using as "dense" | "sparse";
    const queue =
      name === "memory_v2_skills"
        ? state.skillQueryResponses[channel]
        : state.queryResponses[channel];
    return queue.shift() ?? { points: [] };
  }
}

mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: MockQdrantClient,
}));

// Reranker mock — keeps the activation tests hermetic when rerank.enabled is
// flipped on by an integration case. Tests stage `rerankState.scores` to
// program the boost outcome.
const rerankState = {
  scores: null as Map<string, number> | null,
  calls: [] as Array<{ query: string; candidates: string[] }>,
};
mock.module("../reranker.js", () => ({
  rerankCandidates: async (
    query: string,
    candidates: readonly string[],
  ): Promise<Map<string, number>> => {
    rerankState.calls.push({ query, candidates: [...candidates] });
    if (rerankState.scores === null) return new Map();
    const out = new Map<string, number>();
    for (const slug of candidates) {
      const v = rerankState.scores.get(slug);
      if (v !== undefined) out.set(slug, v);
    }
    return out;
  },
  _resetRerankCacheForTests: () => {},
}));

// Static `import type` is fine — types erase, so they don't run module-init
// code that would race the mocks above.
import type { EdgeIndex } from "../edge-index.js";
import type { ActivationState } from "../types.js";

const {
  computeOwnActivation,
  computeSkillActivation,
  selectCandidates,
  selectInjections,
  selectSkillInjections,
  spreadActivation,
} = await import("../activation.js");
const { _resetMemoryV2QdrantForTests } = await import("../qdrant.js");
const { _resetMemoryV2SkillQdrantForTests } =
  await import("../skill-qdrant.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetState(): void {
  state.embedCalls.length = 0;
  state.sparseCalls.length = 0;
  state.embedReturn = [[0.1, 0.2, 0.3]];
  state.sparseReturn = { indices: [1, 2, 3], values: [0.5, 0.5, 0.5] };
  state.queryResponses.dense.length = 0;
  state.queryResponses.sparse.length = 0;
  state.skillQueryResponses.dense.length = 0;
  state.skillQueryResponses.sparse.length = 0;
  state.queryCalls.length = 0;
  rerankState.scores = null;
  rerankState.calls.length = 0;
  // Bun's `mock.module` persists across files in the same process, so the
  // qdrant modules' `_client` singletons may already hold a MockQdrantClient
  // instance from a sibling test file (e.g. sim.test.ts). Resetting both the
  // cache AND any latched readiness forces a fresh `new QdrantClient()` —
  // which under our mock above resolves to *this* file's MockQdrantClient.
  _resetMemoryV2QdrantForTests();
  _resetMemoryV2SkillQdrantForTests();
}

/**
 * Build a minimal AssistantConfig with the v2 weights `simBatch` and the
 * activation pipeline reach for. All non-v2 fields are irrelevant — the
 * embedding backend and qdrant client are mocked.
 */
function makeConfig(
  overrides: Partial<{
    d: number;
    c_user: number;
    c_assistant: number;
    c_now: number;
    epsilon: number;
    dense_weight: number;
    sparse_weight: number;
    ann_candidate_limit: number | null;
  }> = {},
): AssistantConfig {
  return {
    memory: {
      v2: {
        d: 0.3,
        c_user: 0.3,
        c_assistant: 0.2,
        c_now: 0.2,
        epsilon: 0.01,
        dense_weight: 1.0,
        sparse_weight: 0.0,
        ann_candidate_limit: null,
        ...overrides,
      },
    },
  } as unknown as AssistantConfig;
}

/** Stage a single dense + sparse pair on the response queues. */
function stageHybridResponse(
  hits: Array<{ slug: string; denseScore?: number; sparseScore?: number }>,
): void {
  state.queryResponses.dense.push({
    points: hits
      .filter((h) => h.denseScore !== undefined)
      .map((h) => ({ score: h.denseScore, payload: { slug: h.slug } })),
  });
  state.queryResponses.sparse.push({
    points: hits
      .filter((h) => h.sparseScore !== undefined)
      .map((h) => ({ score: h.sparseScore, payload: { slug: h.slug } })),
  });
}

beforeEach(resetState);
afterEach(resetState);

// ---------------------------------------------------------------------------
// selectCandidates
// ---------------------------------------------------------------------------

describe("selectCandidates", () => {
  test("returns empty set when prior state and turn text are both empty", async () => {
    const out = await selectCandidates({
      priorState: null,
      userText: "",
      assistantText: "",
      nowText: "",
      config: makeConfig(),
    });
    expect(out.candidates.size).toBe(0);
    expect(out.fromPrior.size).toBe(0);
    expect(out.fromAnn.size).toBe(0);
    // No turn text → no embedding call, no Qdrant call.
    expect(state.embedCalls).toHaveLength(0);
    expect(state.queryCalls).toHaveLength(0);
  });

  test("carries forward only above-epsilon slugs from prior state", async () => {
    const priorState: ActivationState = {
      messageId: "msg-1",
      state: {
        "alice-vscode": 0.8,
        "bob-coffee": 0.005, // below epsilon
        "carol-jazz": 0.2,
      },
      everInjected: [],
      currentTurn: 1,
      updatedAt: 1,
    };
    const out = await selectCandidates({
      priorState,
      userText: "",
      assistantText: "",
      nowText: "",
      config: makeConfig({ epsilon: 0.01 }),
    });
    expect(out.candidates).toEqual(new Set(["alice-vscode", "carol-jazz"]));
    expect(out.fromPrior).toEqual(new Set(["alice-vscode", "carol-jazz"]));
    expect(out.fromAnn).toEqual(new Set());
  });

  test("unions ANN hits with prior-state survivors", async () => {
    const priorState: ActivationState = {
      messageId: "msg-1",
      state: { "alice-vscode": 0.5 },
      everInjected: [],
      currentTurn: 1,
      updatedAt: 1,
    };
    // ANN hits include one fresh slug — both should appear in the union.
    stageHybridResponse([
      { slug: "alice-vscode", denseScore: 0.6, sparseScore: 1 },
      { slug: "delta-recipe", denseScore: 0.4, sparseScore: 1 },
    ]);
    const out = await selectCandidates({
      priorState,
      userText: "user said hello",
      assistantText: "",
      nowText: "",
      config: makeConfig(),
    });
    expect(out.candidates).toEqual(new Set(["alice-vscode", "delta-recipe"]));
    expect(out.fromPrior).toEqual(new Set(["alice-vscode"]));
    expect(out.fromAnn).toEqual(new Set(["alice-vscode", "delta-recipe"]));
  });

  test("tags overlap: a slug in both sources lands in fromPrior ∩ fromAnn", async () => {
    const priorState: ActivationState = {
      messageId: "msg-1",
      state: {
        "alice-vscode": 0.5, // in prior AND in ANN
        "carol-jazz": 0.3, // prior only
      },
      everInjected: [],
      currentTurn: 1,
      updatedAt: 1,
    };
    stageHybridResponse([
      { slug: "alice-vscode", denseScore: 0.7, sparseScore: 1 }, // overlap
      { slug: "delta-recipe", denseScore: 0.4, sparseScore: 1 }, // ANN only
    ]);

    const out = await selectCandidates({
      priorState,
      userText: "hello",
      assistantText: "",
      nowText: "",
      config: makeConfig(),
    });

    // Overlap: alice-vscode appears in both source sets.
    const overlap = new Set(
      [...out.fromPrior].filter((slug) => out.fromAnn.has(slug)),
    );
    expect(overlap).toEqual(new Set(["alice-vscode"]));

    // candidates = fromPrior ∪ fromAnn.
    const union = new Set<string>([...out.fromPrior, ...out.fromAnn]);
    expect(out.candidates).toEqual(union);
    expect(out.candidates).toEqual(
      new Set(["alice-vscode", "carol-jazz", "delta-recipe"]),
    );

    // Source-set membership matches each slug's actual provenance.
    expect(out.fromPrior).toEqual(new Set(["alice-vscode", "carol-jazz"]));
    expect(out.fromAnn).toEqual(new Set(["alice-vscode", "delta-recipe"]));
  });

  test("ANN candidate query honors `config.memory.v2.ann_candidate_limit` and runs without slug restriction", async () => {
    // Default `ann_candidate_limit: null` → unlimited, so the unlimited
    // sentinel (1_000_000 — a Qdrant-safe stand-in for "every page") is
    // passed to both channels. We don't pin to `MAX_SAFE_INTEGER` here:
    // Qdrant's sparse `SearchContext` pre-allocates `limit * 16` bytes,
    // and `MAX_SAFE_INTEGER` triggers a ~144 PB alloc that SIGABRTs the
    // Qdrant process — so the constant deliberately undercuts it.
    stageHybridResponse([{ slug: "alpha", denseScore: 0.5, sparseScore: 1 }]);
    await selectCandidates({
      priorState: null,
      userText: "hello",
      assistantText: "",
      nowText: "",
      config: makeConfig(),
    });
    expect(state.queryCalls).toHaveLength(2);
    for (const call of state.queryCalls) {
      expect(call.limit).toBe(1_000_000);
      expect(call.filter).toBeUndefined();
    }

    // Explicit override flows through both channels verbatim.
    state.queryCalls.length = 0;
    stageHybridResponse([{ slug: "beta", denseScore: 0.5, sparseScore: 1 }]);
    await selectCandidates({
      priorState: null,
      userText: "hello",
      assistantText: "",
      nowText: "",
      config: makeConfig({ ann_candidate_limit: 25 }),
    });
    expect(state.queryCalls).toHaveLength(2);
    for (const call of state.queryCalls) {
      expect(call.limit).toBe(25);
      expect(call.filter).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// computeOwnActivation
// ---------------------------------------------------------------------------

describe("computeOwnActivation", () => {
  test("empty candidates short-circuits without backend calls", async () => {
    const out = await computeOwnActivation({
      candidates: new Set(),
      priorState: null,
      userText: "user",
      assistantText: "assistant",
      nowText: "now",
      config: makeConfig(),
    });
    expect(out.activation.size).toBe(0);
    expect(out.breakdown.size).toBe(0);
    expect(state.embedCalls).toHaveLength(0);
    expect(state.queryCalls).toHaveLength(0);
  });

  test("applies the formula `d·prev + c_user·simU + c_a·simA + c_now·simN`", async () => {
    // simBatch is called three times (user/assistant/now) — stage three
    // hybrid responses, one per call.
    stageHybridResponse([{ slug: "alice", denseScore: 0.5 }]); // simU
    stageHybridResponse([{ slug: "alice", denseScore: 0.4 }]); // simA
    stageHybridResponse([{ slug: "alice", denseScore: 0.2 }]); // simN

    const priorState: ActivationState = {
      messageId: "msg-1",
      state: { alice: 0.6 },
      everInjected: [],
      currentTurn: 1,
      updatedAt: 1,
    };
    const out = await computeOwnActivation({
      candidates: new Set(["alice"]),
      priorState,
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config: makeConfig({
        d: 0.3,
        c_user: 0.3,
        c_assistant: 0.2,
        c_now: 0.2,
      }),
    });
    // Expected: 0.3*0.6 + 0.3*0.5 + 0.2*0.4 + 0.2*0.2 = 0.18+0.15+0.08+0.04 = 0.45
    expect(out.activation.get("alice")).toBeCloseTo(0.45, 6);
  });

  test("clamps over-1.0 results down to [0, 1]", async () => {
    stageHybridResponse([{ slug: "alice", denseScore: 1.0 }]); // simU
    stageHybridResponse([{ slug: "alice", denseScore: 1.0 }]); // simA
    stageHybridResponse([{ slug: "alice", denseScore: 1.0 }]); // simN

    const priorState: ActivationState = {
      messageId: "msg-1",
      state: { alice: 1.0 },
      everInjected: [],
      currentTurn: 1,
      updatedAt: 1,
    };
    // Sum-to-1 weights guarantee the unclamped result is in [0, 1] already,
    // but the implementation must still clamp defensively. Use weights
    // intentionally over 1 to verify the clamp.
    const out = await computeOwnActivation({
      candidates: new Set(["alice"]),
      priorState,
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config: makeConfig({
        d: 0.5,
        c_user: 0.5,
        c_assistant: 0.5,
        c_now: 0.5,
      }),
    });
    expect(out.activation.get("alice")).toBe(1);
  });

  test("missing prior state defaults `prev` to 0", async () => {
    stageHybridResponse([{ slug: "fresh", denseScore: 1.0 }]); // simU
    stageHybridResponse([{ slug: "fresh", denseScore: 0 }]); // simA
    stageHybridResponse([{ slug: "fresh", denseScore: 0 }]); // simN

    const out = await computeOwnActivation({
      candidates: new Set(["fresh"]),
      priorState: null,
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config: makeConfig({
        d: 0.3,
        c_user: 0.3,
        c_assistant: 0.2,
        c_now: 0.2,
      }),
    });
    // 0.3*0 + 0.3*1 + 0.2*0 + 0.2*0 = 0.3
    expect(out.activation.get("fresh")).toBeCloseTo(0.3, 6);
  });

  test("candidate with no sim hits resolves to 0", async () => {
    stageHybridResponse([]); // simU empty
    stageHybridResponse([]); // simA empty
    stageHybridResponse([]); // simN empty

    const out = await computeOwnActivation({
      candidates: new Set(["ghost"]),
      priorState: null,
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config: makeConfig(),
    });
    expect(out.activation.get("ghost")).toBe(0);
  });

  test("breakdown captures `d * prev` and the raw sims for each candidate", async () => {
    stageHybridResponse([{ slug: "alice", denseScore: 0.5 }]); // simU
    stageHybridResponse([{ slug: "alice", denseScore: 0.4 }]); // simA
    stageHybridResponse([{ slug: "alice", denseScore: 0.2 }]); // simN

    const priorState: ActivationState = {
      messageId: "msg-1",
      state: { alice: 0.6 },
      everInjected: [],
      currentTurn: 1,
      updatedAt: 1,
    };
    const d = 0.3;
    const out = await computeOwnActivation({
      candidates: new Set(["alice"]),
      priorState,
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config: makeConfig({
        d,
        c_user: 0.3,
        c_assistant: 0.2,
        c_now: 0.2,
      }),
    });
    const breakdown = out.breakdown.get("alice");
    expect(breakdown).toBeDefined();
    // priorContribution is `d * prev`, not the weighted sim term.
    expect(breakdown?.priorContribution).toBeCloseTo(d * 0.6, 6);
    // Raw sims, captured before c_user / c_assistant / c_now weighting.
    expect(breakdown?.simUser).toBeCloseTo(0.5, 6);
    expect(breakdown?.simAssistant).toBeCloseTo(0.4, 6);
    expect(breakdown?.simNow).toBeCloseTo(0.2, 6);
  });

  test("breakdown defaults priorContribution to 0 when priorState is null", async () => {
    stageHybridResponse([{ slug: "fresh", denseScore: 0.5 }]);
    stageHybridResponse([{ slug: "fresh", denseScore: 0.5 }]);
    stageHybridResponse([{ slug: "fresh", denseScore: 0.5 }]);

    const out = await computeOwnActivation({
      candidates: new Set(["fresh"]),
      priorState: null,
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config: makeConfig({ d: 0.9 }),
    });
    // No prior state → prev=0 → priorContribution=0 regardless of `d`.
    expect(out.breakdown.get("fresh")?.priorContribution).toBe(0);
  });

  test("rerank boost on user/assistant flips top-1 when fused had it second", async () => {
    // Three Qdrant queries fire in parallel inside computeOwnActivation:
    // user, assistant, now. Stage identical hits for each so the only signal
    // separating slugs is the rerank boost on the user + assistant channels.
    const stagedHits = [
      { slug: "lexical", denseScore: 0.6, sparseScore: 0 },
      { slug: "semantic", denseScore: 0.5, sparseScore: 0 },
    ];
    stageHybridResponse(stagedHits); // user channel
    stageHybridResponse(stagedHits); // assistant channel
    stageHybridResponse(stagedHits); // now channel
    rerankState.scores = new Map([
      ["lexical", 0.05],
      ["semantic", 0.95],
    ]);

    const config = {
      memory: {
        v2: {
          d: 0.0,
          c_user: 0.5,
          c_assistant: 0.5,
          c_now: 0.0,
          dense_weight: 1.0,
          sparse_weight: 0.0,
          rerank: {
            enabled: true,
            top_k: 50,
            alpha: 0.5,
            model: "test-model",
          },
        },
      },
    } as unknown as AssistantConfig;

    const out = await computeOwnActivation({
      candidates: new Set(["lexical", "semantic"]),
      priorState: null,
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config,
    });

    // Without rerank: lexical (0.6) would beat semantic (0.5) on both
    // user and assistant channels.
    // With rerank (alpha=0.5):
    //   lexical:  0.6 + 0.5 · (0.05/0.95) ≈ 0.626
    //   semantic: 0.5 + 0.5 · 1.0 = 1.0
    // The semantic candidate now wins on both rerank-boosted channels.
    expect(out.activation.get("semantic")!).toBeGreaterThan(
      out.activation.get("lexical")!,
    );
    // Rerank should have been called once per rerank-enabled channel.
    expect(rerankState.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// spreadActivation
// ---------------------------------------------------------------------------

/**
 * Build a directed `EdgeIndex` from a flat list of `[from, to]` pairs. Each
 * entry is interpreted as a directed edge `from → to`; self-loops are dropped.
 */
function buildEdgeIndex(edges: Array<[string, string]>): EdgeIndex {
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const [from, to] of edges) {
    if (from === to) continue;
    let outSet = outgoing.get(from);
    if (!outSet) {
      outSet = new Set<string>();
      outgoing.set(from, outSet);
    }
    outSet.add(to);
    let inSet = incoming.get(to);
    if (!inSet) {
      inSet = new Set<string>();
      incoming.set(to, inSet);
    }
    inSet.add(from);
  }
  return { outgoing, incoming };
}

describe("spreadActivation", () => {
  test("orphan node yields A == A_o", () => {
    const edges = buildEdgeIndex([]);
    const own = new Map([["alice", 0.7]]);
    const out = spreadActivation(own, edges, 0.5, 2);
    expect(out.final.get("alice")).toBeCloseTo(0.7, 6);
  });

  test("directed edge boosts only the target, not the source", () => {
    // Edge alice→bob: alice activation flows into bob; bob does NOT push back
    // into alice. alice (a pure source under this graph) keeps its own value.
    const edges = buildEdgeIndex([["alice", "bob"]]);
    const own = new Map([
      ["alice", 0.6],
      ["bob", 0.0],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    // alice has no incoming edges → final == own.
    expect(out.final.get("alice")).toBeCloseTo(0.6, 6);
    // bob's incoming = {alice}: numerator = 0 + 0.5*0.6 = 0.3, denom = 1.5.
    expect(out.final.get("bob")).toBeCloseTo(0.3 / 1.5, 6);
  });

  test("two-cycle (A→B and B→A) lets activation flow both ways", () => {
    // With both directions present, each node is the other's predecessor.
    const edges = buildEdgeIndex([
      ["alice", "bob"],
      ["bob", "alice"],
    ]);
    const own = new Map([
      ["alice", 0.0],
      ["bob", 0.8],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    // alice: incoming {bob}=0.8 → numerator = 0 + 0.5*0.8 = 0.4, denom = 1.5.
    expect(out.final.get("alice")).toBeCloseTo(0.4 / 1.5, 6);
    // bob:   incoming {alice}=0.0 → numerator = 0.8 + 0 = 0.8, denom = 1.5.
    expect(out.final.get("bob")).toBeCloseTo(0.8 / 1.5, 6);
  });

  test("pure source (high outgoing, zero incoming) collapses to final == own", () => {
    // alice → bob → carol; alice has no incoming edges.
    const edges = buildEdgeIndex([
      ["alice", "bob"],
      ["bob", "carol"],
    ]);
    const own = new Map([
      ["alice", 0.5],
      ["bob", 0.0],
      ["carol", 0.0],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    expect(out.final.get("alice")).toBeCloseTo(0.5, 6);
  });

  test("hops=2 reaches second-degree predecessors but stops there", () => {
    // Directed path: alice → bob → carol → delta
    // From delta's perspective: carol is 1-hop predecessor, bob is 2-hop,
    // alice is 3-hop. Activation on bob (2-hop) reaches delta; activation on
    // alice (3-hop) does NOT.
    const edges = buildEdgeIndex([
      ["alice", "bob"],
      ["bob", "carol"],
      ["carol", "delta"],
    ]);
    const own = new Map([
      ["alice", 1.0], // 3-hop predecessor of delta — must NOT contribute
      ["bob", 1.0], // 2-hop predecessor of delta
      ["carol", 0.0],
      ["delta", 0.0],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    // delta: 1-hop {carol}=0, 2-hop {bob}=1.0.
    //   numerator   = 0 + 0.5*0 + 0.25*1.0 = 0.25
    //   denominator = 1 + 0.5*1 + 0.25*1   = 1.75
    //   A = 0.25 / 1.75 ≈ 0.142857
    expect(out.final.get("delta")).toBeCloseTo(0.25 / 1.75, 6);
  });

  test("output is bounded in [0, 1] for arbitrary inputs", () => {
    const edges = buildEdgeIndex([
      ["alice", "bob"],
      ["bob", "carol"],
      ["alice", "carol"],
    ]);
    const own = new Map([
      ["alice", 1.0],
      ["bob", 1.0],
      ["carol", 1.0],
    ]);
    const out = spreadActivation(own, edges, 0.99, 2);
    for (const [, value] of out.final) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  test("hops=0 collapses to A == A_o", () => {
    const edges = buildEdgeIndex([["alice", "bob"]]);
    const own = new Map([
      ["alice", 0.4],
      ["bob", 0.9],
    ]);
    const out = spreadActivation(own, edges, 0.5, 0);
    expect(out.final.get("alice")).toBeCloseTo(0.4, 6);
    expect(out.final.get("bob")).toBeCloseTo(0.9, 6);
  });

  test("k=0 collapses to A == A_o", () => {
    const edges = buildEdgeIndex([["alice", "bob"]]);
    const own = new Map([
      ["alice", 0.4],
      ["bob", 0.9],
    ]);
    const out = spreadActivation(own, edges, 0, 5);
    expect(out.final.get("alice")).toBeCloseTo(0.4, 6);
    expect(out.final.get("bob")).toBeCloseTo(0.9, 6);
  });

  test("predecessors not in the candidate set are dropped from both numerator and denominator", () => {
    // Edge alice→bob: bob has structural predecessor alice, but alice is not
    // in `ownActivation`. With the new formula she contributes nothing —
    // hop1 has no active predecessors so the whole hop drops out of both
    // sides of the ratio. Bob therefore stays at his own activation.
    const edges = buildEdgeIndex([["alice", "bob"]]);
    const own = new Map([["bob", 0.6]]);
    const out = spreadActivation(own, edges, 0.5, 2);
    expect(out.final.get("bob")).toBeCloseTo(0.6, 6);
  });

  test("L_2 norm over multiple active predecessors rewards strong outliers more than avg would", () => {
    // bob has 4 predecessors in the candidate set: one strong, three weak.
    // L_2 = √((0.8² + 0.1² + 0.1² + 0.1²) / 4) = √(0.1675) ≈ 0.40927
    // Plain avg of the same set = 0.275, so L_2 lifts bob more than avg
    // would — the design goal of preferring quality over quantity.
    const edges = buildEdgeIndex([
      ["a1", "bob"],
      ["a2", "bob"],
      ["a3", "bob"],
      ["a4", "bob"],
    ]);
    const own = new Map([
      ["a1", 0.8],
      ["a2", 0.1],
      ["a3", 0.1],
      ["a4", 0.1],
      ["bob", 0.0],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    const rms = Math.sqrt((0.8 * 0.8 + 3 * 0.1 * 0.1) / 4);
    // numerator   = 0 + 0.5 · rms
    // denominator = 1 + 0.5
    expect(out.final.get("bob")).toBeCloseTo((0.5 * rms) / 1.5, 6);
  });

  test("high-in-degree hub with mostly-inactive predecessors stays near A_o", () => {
    // 100 structural predecessors point at hub; only one (`pred0`) is in
    // the candidate set. The old formula would crush hub by the structural
    // count (denominator ≈ 51); the new formula folds the empty bulk out
    // and the L_2 averages over the single active predecessor only.
    const rawEdges: Array<[string, string]> = [];
    for (let i = 0; i < 100; i++) rawEdges.push([`pred${i}`, "hub"]);
    const edges = buildEdgeIndex(rawEdges);
    const own = new Map([
      ["hub", 0.6],
      ["pred0", 0.5],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    // hop1 active = {pred0}, L_2([0.5]) = 0.5.
    //   numerator   = 0.6 + 0.5 · 0.5 = 0.85
    //   denominator = 1 + 0.5         = 1.5
    expect(out.final.get("hub")).toBeCloseTo(0.85 / 1.5, 6);
  });

  test("empty own-activation map returns empty result", () => {
    const out = spreadActivation(
      new Map(),
      buildEdgeIndex([["a", "b"]]),
      0.5,
      2,
    );
    expect(out.final.size).toBe(0);
    expect(out.contribution.size).toBe(0);
  });

  test("contribution equals final - own for each slug", () => {
    // Two-cycle: A→B and B→A so both nodes have predecessors and the spread
    // moves each off its own value in opposite directions.
    const edges = buildEdgeIndex([
      ["alice", "bob"],
      ["bob", "alice"],
    ]);
    const own = new Map([
      ["alice", 0.0],
      ["bob", 0.8],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    for (const [slug, finalValue] of out.final) {
      const ownValue = own.get(slug) ?? 0;
      expect(out.contribution.get(slug)).toBeCloseTo(finalValue - ownValue, 6);
    }
    // alice gained spread (predecessor bob=0.8); bob lost some (predecessor
    // alice=0 dilutes its own 0.8).
    expect(out.contribution.get("alice")).toBeGreaterThan(0);
    expect(out.contribution.get("bob")).toBeLessThan(0);
  });

  test("contribution is 0 for every slug when hops == 0", () => {
    const edges = buildEdgeIndex([["alice", "bob"]]);
    const own = new Map([
      ["alice", 0.4],
      ["bob", 0.9],
    ]);
    const out = spreadActivation(own, edges, 0.5, 0);
    expect(out.contribution.get("alice")).toBe(0);
    expect(out.contribution.get("bob")).toBe(0);
  });

  test("contribution is 0 for every slug when k == 0", () => {
    const edges = buildEdgeIndex([["alice", "bob"]]);
    const own = new Map([
      ["alice", 0.4],
      ["bob", 0.9],
    ]);
    const out = spreadActivation(own, edges, 0, 5);
    expect(out.contribution.get("alice")).toBe(0);
    expect(out.contribution.get("bob")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// selectInjections
// ---------------------------------------------------------------------------

describe("selectInjections", () => {
  test("returns empty when activation is empty", () => {
    const out = selectInjections({
      A: new Map(),
      priorEverInjected: [],
      topK: 5,
    });
    expect(out).toEqual({ topNow: [], toInject: [] });
  });

  test("returns empty when topK is 0", () => {
    const out = selectInjections({
      A: new Map([
        ["alice", 0.5],
        ["bob", 0.4],
      ]),
      priorEverInjected: [],
      topK: 0,
    });
    expect(out).toEqual({ topNow: [], toInject: [] });
  });

  test("ranks by activation descending and trims to topK", () => {
    const out = selectInjections({
      A: new Map([
        ["alice", 0.1],
        ["bob", 0.9],
        ["carol", 0.5],
        ["delta", 0.3],
      ]),
      priorEverInjected: [],
      topK: 2,
    });
    expect(out.topNow).toEqual(["bob", "carol"]);
    expect(out.toInject).toEqual(["bob", "carol"]);
  });

  test("subtracts everInjected slugs from toInject", () => {
    const out = selectInjections({
      A: new Map([
        ["alice", 0.9],
        ["bob", 0.7],
        ["carol", 0.5],
      ]),
      priorEverInjected: [{ slug: "alice", turn: 0 }],
      topK: 5,
    });
    expect(out.topNow).toEqual(["alice", "bob", "carol"]);
    expect(out.toInject).toEqual(["bob", "carol"]);
  });

  test("returns empty toInject when every topNow slug has been injected", () => {
    const out = selectInjections({
      A: new Map([["alice", 0.9]]),
      priorEverInjected: [{ slug: "alice", turn: 1 }],
      topK: 5,
    });
    expect(out.topNow).toEqual(["alice"]);
    expect(out.toInject).toEqual([]);
  });

  test("breaks ties by slug ascending for deterministic output", () => {
    const out = selectInjections({
      A: new Map([
        ["zeta", 0.5],
        ["alice", 0.5],
        ["mike", 0.5],
      ]),
      priorEverInjected: [],
      topK: 5,
    });
    expect(out.topNow).toEqual(["alice", "mike", "zeta"]);
  });
});

// ---------------------------------------------------------------------------
// computeSkillActivation
// ---------------------------------------------------------------------------

/** Stage a single hybrid response on the skills queues (payload key = `id`). */
function stageSkillHybridResponse(
  hits: Array<{ id: string; denseScore?: number; sparseScore?: number }>,
): void {
  state.skillQueryResponses.dense.push({
    points: hits
      .filter((h) => h.denseScore !== undefined)
      .map((h) => ({ score: h.denseScore, payload: { id: h.id } })),
  });
  state.skillQueryResponses.sparse.push({
    points: hits
      .filter((h) => h.sparseScore !== undefined)
      .map((h) => ({ score: h.sparseScore, payload: { id: h.id } })),
  });
}

describe("computeSkillActivation", () => {
  test("empty candidates short-circuits without backend calls", async () => {
    const out = await computeSkillActivation({
      candidates: new Set(),
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config: makeConfig(),
    });
    expect(out.activation.size).toBe(0);
    expect(out.breakdown.size).toBe(0);
    expect(state.embedCalls).toHaveLength(0);
    expect(state.queryCalls).toHaveLength(0);
  });

  test("applies similarity-only formula with no decay term", async () => {
    // Stage three skill responses — one per `simSkillBatch` call.
    stageSkillHybridResponse([{ id: "example-skill-a", denseScore: 0.5 }]); // simU
    stageSkillHybridResponse([{ id: "example-skill-a", denseScore: 0.4 }]); // simA
    stageSkillHybridResponse([{ id: "example-skill-a", denseScore: 0.2 }]); // simN

    const out = await computeSkillActivation({
      candidates: new Set(["example-skill-a"]),
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config: makeConfig({
        d: 0.3,
        c_user: 0.3,
        c_assistant: 0.2,
        c_now: 0.2,
      }),
    });
    // No `d · prev` term: 0.3*0.5 + 0.2*0.4 + 0.2*0.2 = 0.15 + 0.08 + 0.04 = 0.27
    expect(out.activation.get("example-skill-a")).toBeCloseTo(0.27, 6);
  });

  test("output excludes any decay term — d coefficient is unused", async () => {
    // The skill activation formula is `c_user·simU + c_assistant·simA +
    // c_now·simN`. Run with d=0.9 and d=0.0 — if the implementation
    // accidentally included a `d · prev` term, the two would diverge. The
    // function has no priorState parameter, so prev=0; both runs must equal
    // the d-free formula exactly. Stage three sim responses per run.
    const stage = () => {
      stageSkillHybridResponse([{ id: "alpha", denseScore: 0.4 }]);
      stageSkillHybridResponse([{ id: "alpha", denseScore: 0.4 }]);
      stageSkillHybridResponse([{ id: "alpha", denseScore: 0.4 }]);
    };
    const baseConfig = { c_user: 0.3, c_assistant: 0.2, c_now: 0.2 };

    stage();
    const withHighD = await computeSkillActivation({
      candidates: new Set(["alpha"]),
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config: makeConfig({ ...baseConfig, d: 0.9 }),
    });
    stage();
    const withZeroD = await computeSkillActivation({
      candidates: new Set(["alpha"]),
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config: makeConfig({ ...baseConfig, d: 0.0 }),
    });

    // Both equal `0.3*0.4 + 0.2*0.4 + 0.2*0.4 = 0.28` — d is ignored.
    expect(withHighD.activation.get("alpha")).toBeCloseTo(0.28, 6);
    expect(withZeroD.activation.get("alpha")).toBeCloseTo(0.28, 6);
  });

  test("clamps over-1.0 results down to [0, 1]", async () => {
    stageSkillHybridResponse([{ id: "loud-skill", denseScore: 1.0 }]); // simU
    stageSkillHybridResponse([{ id: "loud-skill", denseScore: 1.0 }]); // simA
    stageSkillHybridResponse([{ id: "loud-skill", denseScore: 1.0 }]); // simN

    // Coefficients intentionally sum to > 1 so the unclamped result
    // overshoots — the implementation must still produce <= 1.0.
    const out = await computeSkillActivation({
      candidates: new Set(["loud-skill"]),
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config: makeConfig({
        c_user: 0.5,
        c_assistant: 0.5,
        c_now: 0.5,
      }),
    });
    expect(out.activation.get("loud-skill")).toBe(1);
  });

  test("candidate with no sim hits resolves to 0", async () => {
    stageSkillHybridResponse([]);
    stageSkillHybridResponse([]);
    stageSkillHybridResponse([]);

    const out = await computeSkillActivation({
      candidates: new Set(["ghost-skill"]),
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config: makeConfig(),
    });
    expect(out.activation.get("ghost-skill")).toBe(0);
  });

  test("breakdown captures the raw sims for each candidate", async () => {
    stageSkillHybridResponse([{ id: "example-skill-a", denseScore: 0.5 }]); // simU
    stageSkillHybridResponse([{ id: "example-skill-a", denseScore: 0.4 }]); // simA
    stageSkillHybridResponse([{ id: "example-skill-a", denseScore: 0.2 }]); // simN

    const out = await computeSkillActivation({
      candidates: new Set(["example-skill-a"]),
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config: makeConfig({
        c_user: 0.3,
        c_assistant: 0.2,
        c_now: 0.2,
      }),
    });
    const breakdown = out.breakdown.get("example-skill-a");
    expect(breakdown).toBeDefined();
    expect(breakdown?.simUser).toBeCloseTo(0.5, 6);
    expect(breakdown?.simAssistant).toBeCloseTo(0.4, 6);
    expect(breakdown?.simNow).toBeCloseTo(0.2, 6);
  });

  test("uses the dedicated skills collection and never queries concept pages", async () => {
    stageSkillHybridResponse([{ id: "example-skill-a", denseScore: 0.5 }]);
    stageSkillHybridResponse([{ id: "example-skill-a", denseScore: 0.5 }]);
    stageSkillHybridResponse([{ id: "example-skill-a", denseScore: 0.5 }]);

    await computeSkillActivation({
      candidates: new Set(["example-skill-a"]),
      userText: "u",
      assistantText: "a",
      nowText: "n",
      config: makeConfig(),
    });

    // Three simSkillBatch calls × 2 channels = 6 total queries, all against
    // the skills collection. No spread → no extra calls beyond these.
    expect(state.queryCalls).toHaveLength(6);
    for (const call of state.queryCalls) {
      expect(call.collection).toBe("memory_v2_skills");
    }
  });
});

// ---------------------------------------------------------------------------
// selectSkillInjections
// ---------------------------------------------------------------------------

describe("selectSkillInjections", () => {
  test("returns empty when activation is empty", () => {
    const out = selectSkillInjections({ A: new Map(), topK: 5 });
    expect(out).toEqual({ topNow: [] });
  });

  test("returns empty when topK is 0", () => {
    const out = selectSkillInjections({
      A: new Map([
        ["example-skill-a", 0.5],
        ["example-skill-b", 0.4],
      ]),
      topK: 0,
    });
    expect(out).toEqual({ topNow: [] });
  });

  test("ranks by activation descending and trims to topK", () => {
    const out = selectSkillInjections({
      A: new Map([
        ["example-skill-a", 0.1],
        ["example-skill-b", 0.9],
        ["example-skill-c", 0.5],
        ["example-skill-d", 0.3],
      ]),
      topK: 2,
    });
    expect(out.topNow).toEqual(["example-skill-b", "example-skill-c"]);
  });

  test("skills are stateless: the same id may be returned on consecutive turns", () => {
    // No `everInjected` parameter exists — selectSkillInjections takes only
    // the activation map and topK. So calling it twice with the same A map
    // returns the same result; there is no dedup against prior turns.
    const A = new Map([
      ["example-skill-a", 0.9],
      ["example-skill-b", 0.5],
    ]);
    const turn1 = selectSkillInjections({ A, topK: 5 });
    const turn2 = selectSkillInjections({ A, topK: 5 });
    expect(turn1.topNow).toEqual(["example-skill-a", "example-skill-b"]);
    expect(turn2.topNow).toEqual(turn1.topNow);
  });

  test("breaks ties by id ascending for deterministic output", () => {
    const out = selectSkillInjections({
      A: new Map([
        ["zeta-skill", 0.5],
        ["example-skill-a", 0.5],
        ["mike-skill", 0.5],
      ]),
      topK: 5,
    });
    expect(out.topNow).toEqual(["example-skill-a", "mike-skill", "zeta-skill"]);
  });

  test("topK clamps to the available activation entries", () => {
    const out = selectSkillInjections({
      A: new Map([["only-skill", 0.7]]),
      topK: 100,
    });
    expect(out.topNow).toEqual(["only-skill"]);
  });
});
