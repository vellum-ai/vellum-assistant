import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../../../../config/types.js";

// Keep the real exports (e.g. getQdrantClient) so this partial mock is harmless
// when section-dense-store's transitive imports pull them in; only
// resolveQdrantUrl is pinned to a fixed URL.
const realQdrantClient =
  await import("../../../../../persistence/embeddings/qdrant-client.js");
mock.module("../../../../../persistence/embeddings/qdrant-client.js", () => ({
  ...realQdrantClient,
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

// Stub the shared embedding backend. Records the queries it was asked to embed
// and returns one deterministic vector so `denseLane` can issue the search.
// Keep the real exports (e.g. generateSparseEmbedding) so this partial mock is
// harmless when section-dense-store's transitive imports pull them in; only
// embedWithBackend is replaced.
const realEmbeddingBackend =
  await import("../../../../../persistence/embeddings/embedding-backend.js");
const embedState = {
  calls: [] as string[][],
  throws: null as Error | null,
  dimensionAvailable: true,
  dimensionThrows: null as Error | null,
};
mock.module(
  "../../../../../persistence/embeddings/embedding-backend.js",
  () => ({
    ...realEmbeddingBackend,
    isEmbeddingDimensionAvailable: async () => {
      // Models the availability probe rejecting — e.g. a transient
      // credential-store error surfacing through getProviderKeyAsync.
      if (embedState.dimensionThrows) throw embedState.dimensionThrows;
      return embedState.dimensionAvailable;
    },
    embedWithBackend: async (_config: unknown, inputs: string[]) => {
      embedState.calls.push(inputs);
      if (embedState.throws) throw embedState.throws;
      return {
        provider: "local",
        model: "test-model",
        vectors: inputs.map(() => [0.1, 0.2, 0.3, 0.4]),
      };
    },
  }),
);

// Mock the @qdrant/js-client-rest client. The mock records the query params and
// returns whatever section points the test programmed (in descending score
// order, matching Qdrant's behavior).
type MockPoint = {
  payload: { article: string; ordinal: number };
  score: number;
};

const state = {
  points: [] as MockPoint[],
  queryThrows: null as Error | null,
  queryCalls: [] as Array<{
    collection: string;
    query: unknown;
    limit: number;
  }>,
};

class MockQdrantClient {
  constructor(_opts: unknown) {}
  async query(name: string, params: { query: unknown; limit: number }) {
    state.queryCalls.push({
      collection: name,
      query: params.query,
      limit: params.limit,
    });
    if (state.queryThrows) throw state.queryThrows;
    return { points: state.points };
  }
}

mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: MockQdrantClient,
}));

const { denseLane, denseLaneScored, OVERSAMPLE } = await import("../dense.js");
const { SECTION_COLLECTION, _resetSectionDenseStoreForTests } =
  await import("../section-dense-store.js");

const CONFIG = {
  memory: { qdrant: { vectorSize: 4, onDisk: true } },
} as unknown as AssistantConfig;

function point(article: string, ordinal: number, score: number): MockPoint {
  return { payload: { article, ordinal }, score };
}

function resetState(): void {
  embedState.calls.length = 0;
  embedState.throws = null;
  embedState.dimensionAvailable = true;
  embedState.dimensionThrows = null;
  state.points = [];
  state.queryThrows = null;
  state.queryCalls.length = 0;
  _resetSectionDenseStoreForTests();
}

describe("memory v3 dense lane", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("targets the section collection at k * OVERSAMPLE depth", async () => {
    state.points = [point("page-a", 0, 0.9)];

    await denseLane(CONFIG, "some query", 5);

    // Embedded the query once.
    expect(embedState.calls).toEqual([["some query"]]);
    // Oversampled the section search so dedupe still yields k articles.
    expect(state.queryCalls).toHaveLength(1);
    expect(state.queryCalls[0]!.collection).toBe(SECTION_COLLECTION);
    expect(state.queryCalls[0]!.limit).toBe(5 * OVERSAMPLE);
    expect(state.queryCalls[0]!.query).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  test("dedupes section points to distinct articles with their best section", async () => {
    // page-a's best section is ordinal 2 (highest score); the later page-a
    // section is ignored once the article is already represented.
    state.points = [
      point("page-a", 2, 0.95),
      point("topic-x", 0, 0.9),
      point("page-a", 1, 0.5),
    ];

    const hits = await denseLane(CONFIG, "query", 5);

    expect(hits).toEqual([
      { article: "page-a", section: 2 },
      { article: "topic-x", section: 0 },
    ]);
  });

  test("oversamples then truncates to k distinct articles", async () => {
    state.points = [
      point("page-a", 0, 0.99),
      point("page-b", 0, 0.98),
      point("page-c", 0, 0.97),
      point("page-d", 0, 0.96),
    ];

    const hits = await denseLane(CONFIG, "query", 2);

    expect(hits).toEqual([
      { article: "page-a", section: 0 },
      { article: "page-b", section: 0 },
    ]);
  });

  test("ignores malformed payloads", async () => {
    state.points = [
      {
        payload: {
          article: 123,
          ordinal: 0,
        } as unknown as MockPoint["payload"],
        score: 0.9,
      },
      point("topic-x", 1, 0.8),
    ];

    const hits = await denseLane(CONFIG, "query", 5);

    expect(hits).toEqual([{ article: "topic-x", section: 1 }]);
  });

  test("a thrown Qdrant search degrades to []", async () => {
    state.queryThrows = new Error("qdrant unreachable");

    const hits = await denseLane(CONFIG, "query", 5);

    expect(hits).toEqual([]);
  });

  test("a committed-dimension/reachable-backend mismatch degrades to [] without embedding", async () => {
    // Simulates a 3072-dim collection committed while only a 384-dim backend is
    // reachable: the read lane short-circuits before paying for an embed.
    embedState.dimensionAvailable = false;

    const hits = await denseLane(CONFIG, "query", 5);

    expect(hits).toEqual([]);
    expect(embedState.calls).toEqual([]);
    expect(state.queryCalls).toHaveLength(0);
  });

  test("a rejected availability probe degrades to [] without embedding", async () => {
    // A transient credential-store error can reject the dimension preflight;
    // the lane must still honor its `[]` contract so the orchestrator's
    // unguarded Promise.all does not discard the sibling needle/reply lanes.
    embedState.dimensionThrows = new Error("credential store unreachable");

    const hits = await denseLane(CONFIG, "query", 5);

    expect(hits).toEqual([]);
    expect(embedState.calls).toEqual([]);
    expect(state.queryCalls).toHaveLength(0);
  });

  test("a failed embedding degrades to []", async () => {
    embedState.throws = new Error("embed backend down");

    const hits = await denseLane(CONFIG, "query", 5);

    expect(hits).toEqual([]);
    // No Qdrant round-trip when embedding fails.
    expect(state.queryCalls).toHaveLength(0);
  });

  test("non-positive k short-circuits without a search", async () => {
    const hits = await denseLane(CONFIG, "query", 0);

    expect(hits).toEqual([]);
    expect(embedState.calls).toEqual([]);
    expect(state.queryCalls).toHaveLength(0);
  });
});

describe("denseLaneScored", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("flows raw cosine scores through in descending order, deduped to best section per article", async () => {
    // page-a's best section is ordinal 2 (highest score); the later page-a
    // section is ignored once the article is already represented.
    state.points = [
      point("page-a", 2, 0.95),
      point("topic-x", 0, 0.9),
      point("page-a", 1, 0.5),
    ];

    const hits = await denseLaneScored(CONFIG, "query", 5);

    expect(hits).toEqual([
      { article: "page-a", section: 2, score: 0.95 },
      { article: "topic-x", section: 0, score: 0.9 },
    ]);
  });

  test("a missing point.score defaults to 0", async () => {
    state.points = [
      {
        payload: { article: "page-a", ordinal: 0 },
      } as unknown as MockPoint,
    ];

    const hits = await denseLaneScored(CONFIG, "query", 5);

    expect(hits).toEqual([{ article: "page-a", section: 0, score: 0 }]);
  });

  test("non-positive k short-circuits to []", async () => {
    const hits = await denseLaneScored(CONFIG, "query", 0);

    expect(hits).toEqual([]);
    expect(embedState.calls).toEqual([]);
    expect(state.queryCalls).toHaveLength(0);
  });

  test("a committed-dimension/reachable-backend mismatch degrades to []", async () => {
    embedState.dimensionAvailable = false;

    const hits = await denseLaneScored(CONFIG, "query", 5);

    expect(hits).toEqual([]);
    expect(embedState.calls).toEqual([]);
    expect(state.queryCalls).toHaveLength(0);
  });

  test("a rejected availability probe degrades to []", async () => {
    embedState.dimensionThrows = new Error("credential store unreachable");

    const hits = await denseLaneScored(CONFIG, "query", 5);

    expect(hits).toEqual([]);
    expect(embedState.calls).toEqual([]);
    expect(state.queryCalls).toHaveLength(0);
  });

  test("a thrown Qdrant search degrades to []", async () => {
    state.queryThrows = new Error("qdrant unreachable");

    const hits = await denseLaneScored(CONFIG, "query", 5);

    expect(hits).toEqual([]);
  });

  test("denseLane returns denseLaneScored hits with the score stripped", async () => {
    state.points = [
      point("page-a", 2, 0.95),
      point("topic-x", 0, 0.9),
      point("page-a", 1, 0.5),
    ];

    const scored = await denseLaneScored(CONFIG, "query", 5);
    const plain = await denseLane(CONFIG, "query", 5);

    expect(plain).toEqual(
      scored.map(({ article, section }) => ({ article, section })),
    );
  });
});
