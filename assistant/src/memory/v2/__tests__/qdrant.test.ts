import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Stub getConfig — only the qdrant.url / vectorSize / onDisk fields matter.
mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({
    memory: {
      qdrant: {
        url: "http://127.0.0.1:6333",
        vectorSize: 384,
        onDisk: true,
      },
    },
  }),
}));

mock.module("../../qdrant-client.js", () => ({
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

// Mock the underlying @qdrant/js-client-rest package. The mock client
// records every call and lets each test program the next response.
type MockPoint = {
  id: string;
  vector: { dense: number[]; sparse: { indices: number[]; values: number[] } };
  payload: { slug: string; updated_at: number };
};

const state = {
  collectionExistsBeforeCreate: false,
  collectionExistsCalls: 0,
  createCollectionCalls: 0,
  createCollectionParams: null as unknown,
  createIndexCalls: [] as Array<{ field_name: string; field_schema: string }>,
  upsertCalls: [] as Array<{ wait: boolean; points: MockPoint[] }>,
  deleteCalls: [] as Array<{ wait: boolean; points: string[] }>,
  queryCalls: [] as Array<{
    using: string;
    query: unknown;
    limit: number;
    with_payload: boolean;
  }>,
  // Per-using → response queue. Each entry is consumed in order.
  queryResponses: {
    dense: [] as Array<{
      points: Array<{ score?: number; payload: Record<string, unknown> }>;
    }>,
    sparse: [] as Array<{
      points: Array<{ score?: number; payload: Record<string, unknown> }>;
    }>,
  },
  createCollectionThrows: null as Error | null,
  // Throw queue for upsert: first call shifts and throws if non-null;
  // subsequent calls succeed once the queue is exhausted.
  upsertThrowQueue: [] as Array<Error | null>,
};

class MockQdrantClient {
  constructor(_opts: unknown) {}
  async collectionExists(_name: string) {
    state.collectionExistsCalls++;
    return { exists: state.collectionExistsBeforeCreate };
  }
  async createCollection(_name: string, params: unknown) {
    state.createCollectionCalls++;
    state.createCollectionParams = params;
    if (state.createCollectionThrows) throw state.createCollectionThrows;
    state.collectionExistsBeforeCreate = true;
    return {};
  }
  async createPayloadIndex(
    _name: string,
    params: { field_name: string; field_schema: string },
  ) {
    state.createIndexCalls.push(params);
    return {};
  }
  async upsert(_name: string, params: { wait: boolean; points: MockPoint[] }) {
    if (state.upsertThrowQueue.length > 0) {
      const next = state.upsertThrowQueue.shift();
      if (next) throw next;
    }
    state.upsertCalls.push(params);
    return {};
  }
  async delete(_name: string, params: { wait: boolean; points: string[] }) {
    state.deleteCalls.push(params);
    return {};
  }
  async query(
    _name: string,
    params: {
      using: string;
      query: unknown;
      limit: number;
      with_payload: boolean;
    },
  ) {
    state.queryCalls.push(params);
    const queue = state.queryResponses[params.using as "dense" | "sparse"];
    return queue.shift() ?? { points: [] };
  }
}

mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: MockQdrantClient,
}));

const {
  ensureConceptPageCollection,
  upsertConceptPageEmbedding,
  deleteConceptPageEmbedding,
  hybridQueryConceptPages,
  MEMORY_V2_COLLECTION,
  _resetMemoryV2QdrantForTests,
} = await import("../qdrant.js");

function resetState(): void {
  state.collectionExistsBeforeCreate = false;
  state.collectionExistsCalls = 0;
  state.createCollectionCalls = 0;
  state.createCollectionParams = null;
  state.createIndexCalls.length = 0;
  state.upsertCalls.length = 0;
  state.deleteCalls.length = 0;
  state.queryCalls.length = 0;
  state.queryResponses.dense.length = 0;
  state.queryResponses.sparse.length = 0;
  state.createCollectionThrows = null;
  state.upsertThrowQueue.length = 0;
  _resetMemoryV2QdrantForTests();
}

describe("memory v2 qdrant — collection lifecycle", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("creates the collection with named dense + sparse vectors", async () => {
    state.collectionExistsBeforeCreate = false;

    await ensureConceptPageCollection();

    expect(state.createCollectionCalls).toBe(1);
    const params = state.createCollectionParams as {
      vectors: {
        dense: { size: number; distance: string; on_disk: boolean };
      };
      sparse_vectors: { sparse: Record<string, unknown> };
      hnsw_config: { on_disk: boolean; m: number; ef_construct: number };
      on_disk_payload: boolean;
    };
    expect(params.vectors.dense).toEqual({
      size: 384,
      distance: "Cosine",
      on_disk: true,
    });
    expect(params.sparse_vectors.sparse).toEqual({});
    expect(params.hnsw_config).toEqual({
      on_disk: true,
      m: 16,
      ef_construct: 100,
    });
    expect(params.on_disk_payload).toBe(true);

    // Slug payload index is created up front.
    expect(state.createIndexCalls).toEqual([
      { field_name: "slug", field_schema: "keyword" },
    ]);
  });

  test("uses the documented collection name", () => {
    expect(MEMORY_V2_COLLECTION).toBe("memory_v2_concept_pages");
  });

  test("re-running ensure on an existing collection is a no-op", async () => {
    state.collectionExistsBeforeCreate = true;

    await ensureConceptPageCollection();
    await ensureConceptPageCollection();

    // Existence check fired exactly once thanks to the in-memory readiness
    // cache; createCollection / createPayloadIndex never ran.
    expect(state.createCollectionCalls).toBe(0);
    expect(state.createIndexCalls).toEqual([]);
    expect(state.collectionExistsCalls).toBe(1);
  });

  test("deduplicates concurrent collection creation", async () => {
    state.collectionExistsBeforeCreate = false;

    await Promise.all([
      ensureConceptPageCollection(),
      ensureConceptPageCollection(),
      ensureConceptPageCollection(),
    ]);

    expect(state.collectionExistsCalls).toBe(1);
    expect(state.createCollectionCalls).toBe(1);
    expect(state.createIndexCalls).toEqual([
      { field_name: "slug", field_schema: "keyword" },
    ]);
  });

  test("treats 409-on-create as success (concurrent creation race)", async () => {
    state.collectionExistsBeforeCreate = false;
    const conflict = Object.assign(new Error("Conflict"), { status: 409 });
    state.createCollectionThrows = conflict;

    await ensureConceptPageCollection();

    // Falls through without throwing — collectionReady gets latched.
    expect(state.createCollectionCalls).toBe(1);
    // Index creation is skipped on the 409 path because the racing peer is
    // expected to have created it (it ran the same code).
    expect(state.createIndexCalls).toEqual([]);
  });
});

describe("memory v2 qdrant — upsert", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("upserts a single point keyed by a deterministic slug-derived id", async () => {
    state.collectionExistsBeforeCreate = true;

    await upsertConceptPageEmbedding({
      slug: "alice-prefers-vs-code",
      dense: [0.1, 0.2, 0.3],
      sparse: { indices: [1, 2], values: [0.5, 0.5] },
      updatedAt: 1714000000000,
    });

    expect(state.upsertCalls).toHaveLength(1);
    const call = state.upsertCalls[0];
    expect(call.wait).toBe(true);
    expect(call.points).toHaveLength(1);
    const [point] = call.points;
    expect(point.payload).toEqual({
      slug: "alice-prefers-vs-code",
      updated_at: 1714000000000,
    });
    expect(point.vector.dense).toEqual([0.1, 0.2, 0.3]);
    expect(point.vector.sparse).toEqual({
      indices: [1, 2],
      values: [0.5, 0.5],
    });
    // Point ID is a UUID-shaped string derived from the slug.
    expect(point.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("two upserts for the same slug share the same point id (overwrites in place)", async () => {
    state.collectionExistsBeforeCreate = true;

    await upsertConceptPageEmbedding({
      slug: "bob-uses-zsh",
      dense: [0.1],
      sparse: { indices: [1], values: [1] },
      updatedAt: 1,
    });
    await upsertConceptPageEmbedding({
      slug: "bob-uses-zsh",
      dense: [0.9],
      sparse: { indices: [9], values: [0.5] },
      updatedAt: 2,
    });

    expect(state.upsertCalls).toHaveLength(2);
    expect(state.upsertCalls[0].points[0].id).toBe(
      state.upsertCalls[1].points[0].id,
    );
  });

  test("different slugs map to different point ids", async () => {
    state.collectionExistsBeforeCreate = true;

    await upsertConceptPageEmbedding({
      slug: "alice-prefers-vs-code",
      dense: [0.1],
      sparse: { indices: [1], values: [1] },
      updatedAt: 1,
    });
    await upsertConceptPageEmbedding({
      slug: "bob-uses-zsh",
      dense: [0.1],
      sparse: { indices: [1], values: [1] },
      updatedAt: 1,
    });

    expect(state.upsertCalls[0].points[0].id).not.toBe(
      state.upsertCalls[1].points[0].id,
    );
  });

  test("self-heals from a 404 on upsert by recreating the collection", async () => {
    // Pre-warm: confirm the collection is live so `_collectionReady` latches.
    state.collectionExistsBeforeCreate = true;
    await ensureConceptPageCollection();
    expect(state.collectionExistsCalls).toBe(1);

    // Now simulate the collection being deleted out from under us:
    // the first upsert throws a 404, and the next existence check returns
    // false so the recovery path creates the collection.
    state.upsertThrowQueue.push(
      Object.assign(new Error("Not found"), { status: 404 }),
    );
    state.collectionExistsBeforeCreate = false;

    await upsertConceptPageEmbedding({
      slug: "alice-prefers-vs-code",
      dense: [0.1],
      sparse: { indices: [1], values: [1] },
      updatedAt: 1,
    });

    // Recovery path created the collection and re-attempted the upsert.
    expect(state.createCollectionCalls).toBe(1);
    expect(state.upsertCalls).toHaveLength(1);
  });
});

describe("memory v2 qdrant — delete", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("deletes a slug by its deterministic point id", async () => {
    state.collectionExistsBeforeCreate = true;

    await deleteConceptPageEmbedding("alice-prefers-vs-code");

    expect(state.deleteCalls).toHaveLength(1);
    const call = state.deleteCalls[0];
    expect(call.wait).toBe(true);
    expect(call.points).toHaveLength(1);
    expect(call.points[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("delete is idempotent across repeated calls (no exception)", async () => {
    state.collectionExistsBeforeCreate = true;

    await deleteConceptPageEmbedding("alice-prefers-vs-code");
    await deleteConceptPageEmbedding("alice-prefers-vs-code");

    expect(state.deleteCalls).toHaveLength(2);
  });
});

describe("memory v2 qdrant — hybrid query", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("runs both dense and sparse queries and returns per-channel scores", async () => {
    state.collectionExistsBeforeCreate = true;
    state.queryResponses.dense.push({
      points: [
        { score: 0.91, payload: { slug: "alice-prefers-vs-code" } },
        { score: 0.42, payload: { slug: "bob-uses-zsh" } },
      ],
    });
    state.queryResponses.sparse.push({
      points: [
        { score: 12, payload: { slug: "alice-prefers-vs-code" } },
        { score: 3, payload: { slug: "bob-uses-zsh" } },
      ],
    });

    const results = await hybridQueryConceptPages(
      [0.1, 0.2, 0.3],
      { indices: [1, 2], values: [0.5, 0.5] },
      5,
    );

    // Both queries fired, with the same limit and the right `using`.
    expect(state.queryCalls).toHaveLength(2);
    const usings = state.queryCalls.map((c) => c.using).sort();
    expect(usings).toEqual(["dense", "sparse"]);
    expect(state.queryCalls.every((c) => c.limit === 5)).toBe(true);
    expect(state.queryCalls.every((c) => c.with_payload === true)).toBe(true);

    // Each slug exposes both channel scores.
    expect(results).toHaveLength(2);
    const alice = results.find((r) => r.slug === "alice-prefers-vs-code");
    const bob = results.find((r) => r.slug === "bob-uses-zsh");
    expect(alice).toEqual({
      slug: "alice-prefers-vs-code",
      denseScore: 0.91,
      sparseScore: 12,
    });
    expect(bob).toEqual({
      slug: "bob-uses-zsh",
      denseScore: 0.42,
      sparseScore: 3,
    });
  });

  test("dense-only hits leave sparseScore undefined (and vice versa)", async () => {
    state.collectionExistsBeforeCreate = true;
    state.queryResponses.dense.push({
      points: [{ score: 0.7, payload: { slug: "dense-only" } }],
    });
    state.queryResponses.sparse.push({
      points: [{ score: 2, payload: { slug: "sparse-only" } }],
    });

    const results = await hybridQueryConceptPages(
      [0.1],
      { indices: [1], values: [1] },
      5,
    );

    const denseOnly = results.find((r) => r.slug === "dense-only");
    const sparseOnly = results.find((r) => r.slug === "sparse-only");
    expect(denseOnly).toEqual({ slug: "dense-only", denseScore: 0.7 });
    expect(denseOnly?.sparseScore).toBeUndefined();
    expect(sparseOnly).toEqual({ slug: "sparse-only", sparseScore: 2 });
    expect(sparseOnly?.denseScore).toBeUndefined();
  });

  test("does not use Qdrant-side RRF fusion (separate per-channel queries)", async () => {
    state.collectionExistsBeforeCreate = true;
    state.queryResponses.dense.push({ points: [] });
    state.queryResponses.sparse.push({ points: [] });

    await hybridQueryConceptPages([0.1], { indices: [1], values: [1] }, 5);

    // Each query is a single-channel call (no `prefetch` + `fusion` shape).
    for (const call of state.queryCalls) {
      expect(call).not.toHaveProperty("prefetch");
      const wholeCall = call as unknown as Record<string, unknown>;
      expect(wholeCall.fusion).toBeUndefined();
    }
  });

  test("empty Qdrant responses yield []", async () => {
    state.collectionExistsBeforeCreate = true;
    state.queryResponses.dense.push({ points: [] });
    state.queryResponses.sparse.push({ points: [] });

    const results = await hybridQueryConceptPages(
      [0.1],
      { indices: [1], values: [1] },
      5,
    );
    expect(results).toEqual([]);
  });
});
