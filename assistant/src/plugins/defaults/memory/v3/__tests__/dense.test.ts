import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import type { AssistantConfig } from "../../../../../config/types.js";

// Keep the real exports (e.g. getQdrantClient) so this partial mock is harmless
// when section-dense-store's transitive imports pull them in; only
// resolveQdrantUrl is stubbed to a fixed URL.
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
      if (embedState.dimensionThrows) {
        throw embedState.dimensionThrows;
      }
      return embedState.dimensionAvailable;
    },
    embedWithBackend: async (_config: unknown, inputs: string[]) => {
      embedState.calls.push(inputs);
      if (embedState.throws) {
        throw embedState.throws;
      }
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
  // Whether the collection holds any point, as the chunker version check's
  // `scroll` probe sees it (independent of the programmed query hits).
  collectionHasPoints: false,
  // Fails that probe, as an unreachable Qdrant does.
  scrollThrows: null as Error | null,
};

class MockQdrantClient {
  constructor(_opts: unknown) {}
  async query(name: string, params: { query: unknown; limit: number }) {
    state.queryCalls.push({
      collection: name,
      query: params.query,
      limit: params.limit,
    });
    if (state.queryThrows) {
      throw state.queryThrows;
    }
    return { points: state.points };
  }
  async scroll(_name: string, _params: { limit: number }) {
    if (state.scrollThrows) {
      throw state.scrollThrows;
    }
    return {
      points: state.collectionHasPoints ? [{ id: "1", payload: {} }] : [],
      next_page_offset: null,
    };
  }
}

mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: MockQdrantClient,
}));

// In-memory stand-in for the memory checkpoints the section store's chunker
// rebuild hold reads and writes. `throws` mirrors a checkpoint ledger the
// process cannot read. The real module's other exports are kept so transitive
// importers are unaffected.
const realCheckpoints = {
  ...(await import("../../../../../persistence/checkpoints.js")),
};
const checkpointState = {
  values: new Map<string, string>(),
  throws: null as Error | null,
};
mock.module("../../../../../persistence/checkpoints.js", () => ({
  ...realCheckpoints,
  getMemoryCheckpoint: (key: string) => {
    if (checkpointState.throws) {
      throw checkpointState.throws;
    }
    return checkpointState.values.get(key) ?? null;
  },
  setMemoryCheckpoint: (key: string, value: string) => {
    checkpointState.values.set(key, value);
  },
  deleteMemoryCheckpoint: (key: string) => {
    checkpointState.values.delete(key);
  },
}));

const { denseLane, denseLaneScored, OVERSAMPLE } = await import("../dense.js");
const {
  SECTION_COLLECTION,
  _resetSectionDenseStoreForTests,
  commitSectionEmbedHighWater,
  holdSectionDenseReadsUntilRebuilt,
  MAINTAIN_EMBED_HIGH_WATER_KEY,
  SECTION_CHUNKER_VERSION,
  SECTION_CHUNKER_VERSION_KEY,
  SECTION_REBUILD_PENDING_KEY,
} = await import("../section-dense-store.js");

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
  state.collectionHasPoints = false;
  state.scrollThrows = null;
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

describe("memory v3 dense lane: chunker rebuild hold", () => {
  beforeEach(() => {
    resetState();
    checkpointState.values.clear();
    checkpointState.throws = null;
  });
  afterEach(() => {
    resetState();
    setSystemTime();
  });

  const HIT = [{ article: "page-a", section: 0 }];

  test("a stale chunker version holds reads until the rebuild's high-water commits, then reads resume", async () => {
    state.points = [point("page-a", 0, 0.9)];
    checkpointState.values.set(SECTION_CHUNKER_VERSION_KEY, "1");
    checkpointState.values.set(MAINTAIN_EMBED_HIGH_WATER_KEY, "1700000000000");

    expect(await holdSectionDenseReadsUntilRebuilt()).toBe(true);
    // The reset that forces the rebuild, the marker that outlives a restart,
    // and the version now on record.
    expect(checkpointState.values.has(MAINTAIN_EMBED_HIGH_WATER_KEY)).toBe(
      false,
    );
    expect(checkpointState.values.get(SECTION_REBUILD_PENDING_KEY)).toBe("1");
    expect(checkpointState.values.get(SECTION_CHUNKER_VERSION_KEY)).toBe(
      String(SECTION_CHUNKER_VERSION),
    );
    // Already held: a later lane init in this process starts nothing new.
    expect(await holdSectionDenseReadsUntilRebuilt()).toBe(false);

    // Held: no hits, and no embed or search either.
    expect(await denseLane(CONFIG, "query", 5)).toEqual([]);
    expect(embedState.calls).toEqual([]);
    expect(state.queryCalls).toHaveLength(0);

    // The clean full pass commits its high-water: the marker clears and
    // reads resume.
    commitSectionEmbedHighWater(1700000002000);
    expect(checkpointState.values.get(MAINTAIN_EMBED_HIGH_WATER_KEY)).toBe(
      "1700000002000",
    );
    expect(checkpointState.values.has(SECTION_REBUILD_PENDING_KEY)).toBe(false);
    expect(await denseLane(CONFIG, "query", 5)).toEqual(HIT);
    expect(state.queryCalls).toHaveLength(1);
  });

  test("a restart between the reset and the rebuild resumes the hold from the marker, and another process's commit releases it on the next read", async () => {
    state.points = [point("page-a", 0, 0.9)];
    checkpointState.values.set(
      SECTION_CHUNKER_VERSION_KEY,
      String(SECTION_CHUNKER_VERSION),
    );
    checkpointState.values.set(SECTION_REBUILD_PENDING_KEY, "1");

    expect(await holdSectionDenseReadsUntilRebuilt()).toBe(true);
    expect(await denseLane(CONFIG, "query", 5)).toEqual([]);

    // The memory worker's pass completed: its commit cleared the marker.
    checkpointState.values.delete(SECTION_REBUILD_PENDING_KEY);
    expect(await denseLane(CONFIG, "query", 5)).toEqual(HIT);
  });

  test("a matching version changes nothing: no hold, no checkpoint writes, reads proceed", async () => {
    state.points = [point("page-a", 0, 0.9)];
    checkpointState.values.set(
      SECTION_CHUNKER_VERSION_KEY,
      String(SECTION_CHUNKER_VERSION),
    );
    checkpointState.values.set(MAINTAIN_EMBED_HIGH_WATER_KEY, "1700000000000");

    expect(await holdSectionDenseReadsUntilRebuilt()).toBe(false);
    expect(checkpointState.values.get(MAINTAIN_EMBED_HIGH_WATER_KEY)).toBe(
      "1700000000000",
    );
    expect(checkpointState.values.has(SECTION_REBUILD_PENDING_KEY)).toBe(false);
    expect(await denseLane(CONFIG, "query", 5)).toEqual(HIT);
  });

  test("a fresh install (no high-water, empty collection) records the version without a hold", async () => {
    state.points = [point("page-a", 0, 0.9)];

    expect(await holdSectionDenseReadsUntilRebuilt()).toBe(false);
    expect(checkpointState.values.get(SECTION_CHUNKER_VERSION_KEY)).toBe(
      String(SECTION_CHUNKER_VERSION),
    );
    expect(checkpointState.values.has(SECTION_REBUILD_PENDING_KEY)).toBe(false);
    expect(await denseLane(CONFIG, "query", 5)).toEqual(HIT);
  });

  test("a version-less install whose collection already holds points is held and forced to rebuild", async () => {
    state.points = [point("page-a", 0, 0.9)];
    state.collectionHasPoints = true;

    // No version, no high-water, no marker, yet points in the collection: an
    // install whose passes never committed cleanly. Its points were built by
    // another chunker, so it is stale, not fresh.
    expect(await holdSectionDenseReadsUntilRebuilt()).toBe(true);
    expect(checkpointState.values.get(SECTION_REBUILD_PENDING_KEY)).toBe("1");
    expect(checkpointState.values.get(SECTION_CHUNKER_VERSION_KEY)).toBe(
      String(SECTION_CHUNKER_VERSION),
    );
    expect(await denseLane(CONFIG, "query", 5)).toEqual([]);

    commitSectionEmbedHighWater(1700000002000);
    expect(await denseLane(CONFIG, "query", 5)).toEqual(HIT);
  });

  test("a checkpoint ledger that cannot be read holds dense reads until a retried check completes", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    state.points = [point("page-a", 0, 0.9)];
    checkpointState.throws = new Error("no such table: memory_checkpoints");

    // An unreadable ledger cannot prove the stored ordinals are safe, so the
    // hold stays on. The read path retries the check once its cooldown has
    // elapsed, and a ledger that recovers with nothing pending releases it.
    expect(await holdSectionDenseReadsUntilRebuilt()).toBe(true);
    expect(await denseLane(CONFIG, "query", 5)).toEqual([]);
    checkpointState.throws = null;
    expect(await denseLane(CONFIG, "query", 5)).toEqual([]);

    setSystemTime(new Date("2026-01-01T00:01:00Z"));
    expect(await denseLane(CONFIG, "query", 5)).toEqual(HIT);
    expect(checkpointState.values.get(SECTION_CHUNKER_VERSION_KEY)).toBe(
      String(SECTION_CHUNKER_VERSION),
    );
  });

  test("a collection probe that fails at lane init holds reads; once Qdrant recovers, the next read past the cooldown retries the check, marks the rebuild, kicks it, and the commit releases", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    state.points = [point("page-a", 0, 0.9)];
    state.collectionHasPoints = true;
    state.scrollThrows = new Error("qdrant unreachable");
    const kicks: number[] = [];

    // No version, no high-water, no marker: only the probe can say whether
    // the points are stale, and it cannot run. Held, nothing written, and no
    // rebuild kicked yet.
    expect(
      await holdSectionDenseReadsUntilRebuilt(() => kicks.push(kicks.length)),
    ).toBe(true);
    expect(await denseLane(CONFIG, "query", 5)).toEqual([]);
    expect(checkpointState.values.size).toBe(0);
    expect(kicks).toEqual([]);

    // Qdrant is back. The next read past the cooldown completes the
    // transition the init check could not: marker written, version
    // recorded, rebuild kicked, and the read itself still serves nothing.
    state.scrollThrows = null;
    setSystemTime(new Date("2026-01-01T00:01:00Z"));
    expect(await denseLane(CONFIG, "query", 5)).toEqual([]);
    expect(checkpointState.values.get(SECTION_REBUILD_PENDING_KEY)).toBe("1");
    expect(checkpointState.values.get(SECTION_CHUNKER_VERSION_KEY)).toBe(
      String(SECTION_CHUNKER_VERSION),
    );
    expect(kicks).toEqual([0]);
    expect(state.queryCalls).toHaveLength(0);

    // From here the marker governs: the rebuild's commit releases the hold.
    commitSectionEmbedHighWater(1700000002000);
    expect(await denseLane(CONFIG, "query", 5)).toEqual(HIT);
  });
});
