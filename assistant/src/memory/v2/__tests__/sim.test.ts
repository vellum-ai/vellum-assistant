/**
 * Tests for `memory/v2/sim.ts` — hybrid dense + sparse similarity over the
 * v2 concept-page collection.
 *
 * The embedding backend and the underlying `@qdrant/js-client-rest` are both
 * mocked so the test is hermetic and fast. We mock at the Qdrant client
 * level (not at `../qdrant.js`) so the real `hybridQueryConceptPages`
 * implementation runs end-to-end — that way nothing about the v2 qdrant
 * module's exports leaks into other test files in the same Bun process.
 *
 * Coverage:
 *   - clamp01 boundaries.
 *   - simBatch fusion math (`dense_weight`, `sparse_weight`,
 *     sparse-batch normalization, [0,1] clamp).
 *   - The Qdrant query is filtered to the candidate slugs.
 *   - Empty candidate list short-circuits without backend calls.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";
import type { AssistantConfig } from "../../../config/types.js";

// ---------------------------------------------------------------------------
// Module-level mocks (registered before `await import("../sim.js")`).
// ---------------------------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Stub both `getConfig` and `loadConfig`. `loadConfig` is reached by code
// paths transitively imported during teardown (e.g. dynamic imports inside
// `oauth2.ts`); leaving it undefined here would break sibling test files
// run in the same Bun process because `mock.module` replacements persist
// across files.
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

// Same partial-mock pattern as for the embedding backend: re-export the
// real symbols and override only `resolveQdrantUrl` so the v2 qdrant
// client picks up our test URL.
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
  // Programmable Qdrant query response — one entry per `using` channel,
  // shifted in order so each test can stage dense + sparse results.
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

// Re-export every real symbol from the embedding-backend module, overriding
// only the two we control. Bun's `mock.module` replacement is process-wide,
// so a partial mock here would break sibling test files that import other
// exports from the same module (`selectEmbeddingBackend`, etc.).
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
    // The v2 qdrant module's readiness cache latches on the first call,
    // so reporting "exists: true" once is enough for every test.
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

const { simBatch, clamp01 } = await import("../sim.js");

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
}

function configWithWeights(
  denseWeight: number,
  sparseWeight: number,
): AssistantConfig {
  // Only the fields sim.ts touches are populated; the rest of AssistantConfig
  // is irrelevant here because `embedWithBackend` is mocked.
  return {
    memory: {
      v2: {
        dense_weight: denseWeight,
        sparse_weight: sparseWeight,
      },
    },
  } as unknown as AssistantConfig;
}

/**
 * Stage a single Qdrant response that maps each (slug, denseScore?, sparseScore?)
 * tuple onto the dense or sparse channel, mirroring how `hybridQueryConceptPages`
 * merges per-channel hits.
 */
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
// clamp01
// ---------------------------------------------------------------------------

describe("clamp01", () => {
  test("passes values already in [0, 1] through unchanged", () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });

  test("clamps negatives to 0 and overshoot to 1", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
    expect(clamp01(1.0001)).toBe(1);
    expect(clamp01(Infinity)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// simBatch
// ---------------------------------------------------------------------------

describe("simBatch", () => {
  test("empty candidate list returns empty map without touching backends", async () => {
    const config = configWithWeights(0.7, 0.3);

    const out = await simBatch("anything", [], config);

    expect(out.size).toBe(0);
    expect(state.embedCalls).toHaveLength(0);
    expect(state.sparseCalls).toHaveLength(0);
    expect(state.queryCalls).toHaveLength(0);
  });

  test("identical text yields ~1.0 when both channels max out", async () => {
    const config = configWithWeights(0.7, 0.3);
    stageHybridResponse([
      // The only candidate hits both channels at their maxima
      // (cosine ~ 1.0; sparse score equals the batch max).
      { slug: "alice-vscode", denseScore: 1.0, sparseScore: 42 },
    ]);

    const out = await simBatch(
      "alice prefers vs code",
      ["alice-vscode"],
      config,
    );

    expect(out.get("alice-vscode")).toBeCloseTo(1.0, 6);
  });

  test("orthogonal text yields ~0 when both channels miss", async () => {
    const config = configWithWeights(0.7, 0.3);
    stageHybridResponse([]); // No hits in either channel.

    const out = await simBatch("totally unrelated", ["alice-vscode"], config);

    // Slugs absent from both channels are absent from the result map.
    expect(out.size).toBe(0);
  });

  test("dense-only hit gets sparse contribution of 0", async () => {
    const config = configWithWeights(0.7, 0.3);
    stageHybridResponse([
      { slug: "dense-only-page", denseScore: 0.5 /* sparseScore omitted */ },
    ]);

    const out = await simBatch("query", ["dense-only-page"], config);

    // 0.7 * 0.5 + 0.3 * 0 = 0.35
    expect(out.get("dense-only-page")).toBeCloseTo(0.35, 6);
  });

  test("sparse-only hit gets dense contribution of 0; sparse normalized to 1.0", async () => {
    const config = configWithWeights(0.7, 0.3);
    stageHybridResponse([
      { slug: "sparse-only-page", sparseScore: 7.5 /* denseScore omitted */ },
    ]);

    const out = await simBatch("query", ["sparse-only-page"], config);

    // Single entry → sparse normalizes to 1.0; 0.7 * 0 + 0.3 * 1.0 = 0.3
    expect(out.get("sparse-only-page")).toBeCloseTo(0.3, 6);
  });

  test("sparse normalization divides by per-batch max", async () => {
    const config = configWithWeights(0.0, 1.0);
    stageHybridResponse([
      { slug: "alice", denseScore: 0.0, sparseScore: 10 },
      { slug: "bob", denseScore: 0.0, sparseScore: 5 },
      { slug: "carol", denseScore: 0.0, sparseScore: 2 },
    ]);

    const out = await simBatch("query", ["alice", "bob", "carol"], config);

    // With dense_weight=0 and sparse_weight=1, scores equal the
    // batch-normalized sparse values: max=10 maps to 1.0, others scale.
    expect(out.get("alice")).toBeCloseTo(1.0, 6);
    expect(out.get("bob")).toBeCloseTo(0.5, 6);
    expect(out.get("carol")).toBeCloseTo(0.2, 6);
  });

  test("respects the configured weight blend", async () => {
    const config = configWithWeights(0.4, 0.6);
    stageHybridResponse([
      { slug: "alice", denseScore: 0.5, sparseScore: 4 }, // sparse-norm = 1.0
      { slug: "bob", denseScore: 0.25, sparseScore: 2 }, //  sparse-norm = 0.5
    ]);

    const out = await simBatch("query", ["alice", "bob"], config);

    // alice: 0.4 * 0.5 + 0.6 * 1.0 = 0.8
    // bob:   0.4 * 0.25 + 0.6 * 0.5 = 0.4
    expect(out.get("alice")).toBeCloseTo(0.8, 6);
    expect(out.get("bob")).toBeCloseTo(0.4, 6);
  });

  test("scores are clamped into [0, 1] even when fused values overshoot", async () => {
    // Construct a mock response where the raw fusion exceeds 1.0; the
    // function still must produce <= 1.0.
    const config = configWithWeights(0.8, 0.5); // intentionally sums to 1.3
    stageHybridResponse([
      { slug: "loud-page", denseScore: 1.0, sparseScore: 1 }, // sparse-norm 1.0
    ]);

    const out = await simBatch("query", ["loud-page"], config);

    expect(out.get("loud-page")).toBe(1);
  });

  test("forwards the candidate slugs as a Qdrant slug-IN filter", async () => {
    const config = configWithWeights(0.7, 0.3);
    stageHybridResponse([]);

    await simBatch("query", ["alice", "bob", "carol"], config);

    // Both channels (dense + sparse) ran with the same slug-restriction
    // filter and the same per-channel limit equal to the candidate count.
    expect(state.queryCalls).toHaveLength(2);
    for (const call of state.queryCalls) {
      expect(call.limit).toBe(3);
      expect(call.filter).toEqual({
        must: [{ key: "slug", match: { any: ["alice", "bob", "carol"] } }],
      });
    }
  });

  test("embeds the query text exactly once via dense + sparse backends", async () => {
    const config = configWithWeights(0.7, 0.3);
    stageHybridResponse([]);

    await simBatch("hello world", ["alice"], config);

    expect(state.embedCalls).toHaveLength(1);
    expect(state.embedCalls[0].inputs).toEqual(["hello world"]);
    expect(state.sparseCalls).toEqual(["hello world"]);
  });

  test("returned scores are always in [0, 1] for arbitrary inputs", async () => {
    const config = configWithWeights(0.7, 0.3);
    stageHybridResponse([
      { slug: "a", denseScore: 0.99, sparseScore: 100 },
      { slug: "b", denseScore: 0.5, sparseScore: 50 },
      { slug: "c", denseScore: 0.0, sparseScore: 1 },
      { slug: "d", denseScore: 0.123, sparseScore: 0 }, // explicit zero
    ]);

    const out = await simBatch("query", ["a", "b", "c", "d"], config);

    for (const [, score] of out) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});
