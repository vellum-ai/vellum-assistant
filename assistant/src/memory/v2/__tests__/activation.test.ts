/**
 * Tests for `memory/v2/activation.ts` — per-turn activation update.
 *
 * Coverage:
 *   - `selectCandidates`: union of (above-epsilon prior state) ∪ (ANN top-50);
 *      empty turn text skips ANN; empty everywhere returns empty set.
 *   - `computeOwnActivation`: applies `A_o = d·prev + c_user·simU + c_a·simA +
 *      c_now·simN`; clamps to [0,1]; orphan in candidates returns 0 when no
 *      sim hits.
 *   - `spreadActivation`: orphan yields A == A_o; symmetric two-node ring is
 *      symmetric; hops=2 reaches second-degree but not third; bounded in [0,1].
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
  queryCalls: [] as Array<{
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
    _name: string,
    params: { using: string; limit: number; filter?: unknown },
  ) {
    state.queryCalls.push({
      using: params.using,
      limit: params.limit,
      filter: params.filter,
    });
    const queue = state.queryResponses[params.using as "dense" | "sparse"];
    return queue.shift() ?? { points: [] };
  }
}

mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: MockQdrantClient,
}));

// Static `import type` is fine — types erase, so they don't run module-init
// code that would race the mocks above.
import type { ActivationState, EdgesIndex } from "../types.js";

const {
  computeOwnActivation,
  selectCandidates,
  selectInjections,
  spreadActivation,
} = await import("../activation.js");
const { _resetMemoryV2QdrantForTests } = await import("../qdrant.js");

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
  state.queryCalls.length = 0;
  // Bun's `mock.module` persists across files in the same process, so the
  // qdrant module's `_client` singleton can be a MockQdrantClient instance
  // installed by a sibling test file (e.g. sim.test.ts). Resetting both the
  // cache AND any latched readiness forces a fresh `new QdrantClient()` —
  // which under our mock above resolves to *this* file's MockQdrantClient.
  _resetMemoryV2QdrantForTests();
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
    expect(out.size).toBe(0);
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
    expect(out).toEqual(new Set(["alice-vscode", "carol-jazz"]));
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
    expect(out).toEqual(new Set(["alice-vscode", "delta-recipe"]));
  });

  test("ANN top-K limit equals 50 and runs without slug restriction", async () => {
    stageHybridResponse([{ slug: "alpha", denseScore: 0.5, sparseScore: 1 }]);
    await selectCandidates({
      priorState: null,
      userText: "hello",
      assistantText: "",
      nowText: "",
      config: makeConfig(),
    });
    // Both channels (dense + sparse) ran with limit=50 and no filter.
    expect(state.queryCalls).toHaveLength(2);
    for (const call of state.queryCalls) {
      expect(call.limit).toBe(50);
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
    expect(out.size).toBe(0);
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
    expect(out.get("alice")).toBeCloseTo(0.45, 6);
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
    expect(out.get("alice")).toBe(1);
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
    expect(out.get("fresh")).toBeCloseTo(0.3, 6);
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
    expect(out.get("ghost")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// spreadActivation
// ---------------------------------------------------------------------------

describe("spreadActivation", () => {
  test("orphan node yields A == A_o", () => {
    const edges: EdgesIndex = { version: 1, edges: [] };
    const own = new Map([["alice", 0.7]]);
    const out = spreadActivation(own, edges, 0.5, 2);
    expect(out.get("alice")).toBeCloseTo(0.7, 6);
  });

  test("symmetric two-node ring yields symmetric activation", () => {
    const edges: EdgesIndex = {
      version: 1,
      edges: [["alice", "bob"]],
    };
    const own = new Map([
      ["alice", 0.6],
      ["bob", 0.6],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    // Both nodes have one neighbor, equal own-activation → equal final A.
    expect(out.get("alice")).toBeCloseTo(out.get("bob") ?? 0, 6);
    // Numerator: 0.6 + 0.5*0.6 = 0.9. Denominator: 1 + 0.5*1 = 1.5. A = 0.6.
    expect(out.get("alice")).toBeCloseTo(0.6, 6);
  });

  test("asymmetric two-node ring picks up neighbor activation", () => {
    const edges: EdgesIndex = {
      version: 1,
      edges: [["alice", "bob"]],
    };
    const own = new Map([
      ["alice", 0.0],
      ["bob", 0.8],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    // alice: numerator = 0 + 0.5*0.8 = 0.4. denominator = 1 + 0.5 = 1.5.
    //        A = 0.2666...
    expect(out.get("alice")).toBeCloseTo(0.4 / 1.5, 6);
    // bob:   numerator = 0.8 + 0.5*0 = 0.8. denominator = 1.5. A = 0.5333...
    expect(out.get("bob")).toBeCloseTo(0.8 / 1.5, 6);
  });

  test("hops=2 reaches second-degree neighbors but stops there", () => {
    // Path graph: alice -- bob -- carol -- delta
    // From alice's perspective: bob is 1-hop, carol is 2-hop, delta is 3-hop.
    const edges: EdgesIndex = {
      version: 1,
      edges: [
        ["alice", "bob"],
        ["bob", "carol"],
        ["carol", "delta"],
      ],
    };
    const own = new Map([
      ["alice", 0.0],
      ["bob", 0.0],
      ["carol", 1.0], // 2 hops from alice
      ["delta", 1.0], // 3 hops from alice — must NOT contribute
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    // alice: 1-hop = {bob} (0), 2-hop = {carol} (1.0).
    //   numerator   = 0 + 0.5*0 + 0.25*1.0 = 0.25
    //   denominator = 1 + 0.5*1 + 0.25*1   = 1.75
    //   A = 0.25 / 1.75 ≈ 0.142857
    expect(out.get("alice")).toBeCloseTo(0.25 / 1.75, 6);
  });

  test("output is bounded in [0, 1] for arbitrary inputs", () => {
    const edges: EdgesIndex = {
      version: 1,
      edges: [
        ["alice", "bob"],
        ["bob", "carol"],
        ["alice", "carol"],
      ],
    };
    const own = new Map([
      ["alice", 1.0],
      ["bob", 1.0],
      ["carol", 1.0],
    ]);
    const out = spreadActivation(own, edges, 0.99, 2);
    for (const [, value] of out) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  test("hops=0 collapses to A == A_o", () => {
    const edges: EdgesIndex = {
      version: 1,
      edges: [["alice", "bob"]],
    };
    const own = new Map([
      ["alice", 0.4],
      ["bob", 0.9],
    ]);
    const out = spreadActivation(own, edges, 0.5, 0);
    expect(out.get("alice")).toBeCloseTo(0.4, 6);
    expect(out.get("bob")).toBeCloseTo(0.9, 6);
  });

  test("k=0 collapses to A == A_o", () => {
    const edges: EdgesIndex = {
      version: 1,
      edges: [["alice", "bob"]],
    };
    const own = new Map([
      ["alice", 0.4],
      ["bob", 0.9],
    ]);
    const out = spreadActivation(own, edges, 0, 5);
    expect(out.get("alice")).toBeCloseTo(0.4, 6);
    expect(out.get("bob")).toBeCloseTo(0.9, 6);
  });

  test("missing neighbor activation contributes 0 to the numerator", () => {
    // alice and bob are connected, but bob is not in `ownActivation` — so
    // bob's contribution is 0, while the denominator still counts the
    // structural neighbor.
    const edges: EdgesIndex = {
      version: 1,
      edges: [["alice", "bob"]],
    };
    const own = new Map([["alice", 0.6]]);
    const out = spreadActivation(own, edges, 0.5, 2);
    // numerator = 0.6 + 0.5*0 = 0.6. denominator = 1 + 0.5*1 = 1.5.
    expect(out.get("alice")).toBeCloseTo(0.4, 6);
  });

  test("empty own-activation map returns empty result", () => {
    const out = spreadActivation(
      new Map(),
      { version: 1, edges: [["a", "b"]] },
      0.5,
      2,
    );
    expect(out.size).toBe(0);
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
