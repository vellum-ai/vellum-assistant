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
import type { Section } from "../types.js";

mock.module("../../../../../persistence/embeddings/qdrant-client.js", () => ({
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

// Stub the shared embedding backend. Records inputs and returns one
// deterministic vector per input so `upsertSections` can map vectors → points.
// `statusProvider/Model` is what `getMemoryBackendStatus` reports (the cache-read
// identity); `embedProvider/Model` is what `embedWithBackend` returns — kept
// separate so a test can simulate a provider rotation between the two.
const embedState = {
  calls: [] as string[][],
  dim: 4,
  statusProvider: "local" as string | null,
  statusModel: "test-model" as string | null,
  embedProvider: "local",
  embedModel: "test-model",
  // Gemini embedding options that change the vector for identical text. The
  // mocked `geminiCacheExtras` renders these into cache-key fragments exactly
  // as the production helper does, so a test can flip the task type and assert
  // the section cache treats it as a miss.
  geminiTaskType: undefined as string | undefined,
  geminiDimensions: undefined as number | undefined,
};
mock.module(
  "../../../../../persistence/embeddings/embedding-backend.js",
  () => ({
    getMemoryBackendStatus: async () => ({
      enabled: true,
      degraded: false,
      provider: embedState.statusProvider,
      model: embedState.statusModel,
      reason: null,
    }),
    embedWithBackend: async (_config: unknown, inputs: string[]) => {
      embedState.calls.push(inputs);
      return {
        provider: embedState.embedProvider,
        model: embedState.embedModel,
        vectors: inputs.map((_input, i) =>
          Array.from({ length: embedState.dim }, (_v, j) => (i + 1) * (j + 1)),
        ),
      };
    },
    geminiCacheExtras: () => {
      const extras: string[] = [];
      if (embedState.geminiTaskType) {
        extras.push(`task=${embedState.geminiTaskType}`);
      }
      if (embedState.geminiDimensions != null) {
        extras.push(`dim=${embedState.geminiDimensions}`);
      }
      return extras;
    },
  }),
);

// In-memory stand-in for the `memory_embeddings` dense cache. Lets each test
// program hits/misses without a real DB; keyed exactly as the production helper
// (`targetType|targetId|provider|model`) with a stored dimension for the
// dim-match gate. `getDb` is stubbed to a sentinel since the mock ignores it.
const cacheState = {
  store: new Map<
    string,
    { dense: number[]; contentHash: string; dimensions: number }
  >(),
  reads: [] as string[],
};
function cacheKey(k: {
  targetType: string;
  targetId: string;
  provider: string;
  model: string;
}): string {
  return `${k.targetType}|${k.targetId}|${k.provider}|${k.model}`;
}
mock.module("../../../../../persistence/embeddings/embedding-cache.js", () => ({
  readEmbeddingCache: (
    _db: unknown,
    key: {
      targetType: string;
      targetId: string;
      provider: string;
      model: string;
      expectedDim: number;
    },
  ) => {
    cacheState.reads.push(cacheKey(key));
    const row = cacheState.store.get(cacheKey(key));
    if (!row || row.dimensions !== key.expectedDim) {
      return null;
    }
    return { dense: row.dense, contentHash: row.contentHash };
  },
  writeEmbeddingCache: (
    _db: unknown,
    params: {
      targetType: string;
      targetId: string;
      provider: string;
      model: string;
      dense: number[];
      contentHash: string;
    },
  ) => {
    cacheState.store.set(cacheKey(params), {
      dense: params.dense,
      contentHash: params.contentHash,
      dimensions: params.dense.length,
    });
  },
}));

mock.module("../../../../../persistence/db-connection.js", () => ({
  getDb: () => ({}),
  // The section store resolves the embedding cache on the memory connection via
  // `memoryDbOrNull`; hand back truthy sentinels so it takes the cache path.
  getMemoryDb: () => ({}),
  getMemorySqlite: () => ({}),
}));

// Mock the underlying @qdrant/js-client-rest package. The mock client records
// every call and lets each test program collection existence.
type MockPoint = {
  id: string;
  vector: number[];
  payload: { article: string; ordinal: number; title: string };
};

/** One programmed `scroll` page: the points to return and the next offset. */
type ScrollPage = {
  points: Array<{ id: string; payload: { article?: unknown } }>;
  next_page_offset: string | number | null;
};

// A getCollection() response for an existing collection whose single dense
// vector matches the configured dimension (CONFIG.vectorSize === 4).
const MATCHING_SECTION_SCHEMA = {
  config: { params: { vectors: { size: 4, distance: "Cosine" } } },
};

const state = {
  collectionExists: false,
  collectionExistsCalls: 0,
  createCollectionCalls: 0,
  createCollectionParams: null as unknown,
  createIndexCalls: [] as Array<{ field_name: string; field_schema: string }>,
  upsertCalls: [] as Array<{ wait: boolean; points: MockPoint[] }>,
  deleteCalls: [] as Array<{ wait: boolean; filter: unknown }>,
  createCollectionThrows: null as Error | null,
  getCollectionCalls: 0,
  getCollectionInfo: MATCHING_SECTION_SCHEMA as unknown,
  getCollectionThrows: null as Error | null,
  deleteCollectionCalls: [] as string[],
  // Programmed `scroll` pages, consumed in order; each `scroll` call shifts one.
  scrollPages: [] as ScrollPage[],
  scrollCalls: [] as Array<{ limit: number; offset: unknown }>,
  scrollThrows: null as Error | null,
};

class MockQdrantClient {
  constructor(_opts: unknown) {}
  async collectionExists(_name: string) {
    state.collectionExistsCalls++;
    return { exists: state.collectionExists };
  }
  async createCollection(_name: string, params: unknown) {
    state.createCollectionCalls++;
    state.createCollectionParams = params;
    if (state.createCollectionThrows) {
      throw state.createCollectionThrows;
    }
    state.collectionExists = true;
    return {};
  }
  async getCollection(_name: string) {
    state.getCollectionCalls++;
    if (state.getCollectionThrows) {
      throw state.getCollectionThrows;
    }
    return state.getCollectionInfo;
  }
  async deleteCollection(name: string) {
    state.deleteCollectionCalls.push(name);
    state.collectionExists = false;
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
    state.upsertCalls.push(params);
    return {};
  }
  async delete(_name: string, params: { wait: boolean; filter: unknown }) {
    state.deleteCalls.push(params);
    return {};
  }
  async scroll(
    _name: string,
    params: { limit: number; offset?: unknown },
  ): Promise<ScrollPage> {
    state.scrollCalls.push({ limit: params.limit, offset: params.offset });
    if (state.scrollThrows) {
      throw state.scrollThrows;
    }
    return state.scrollPages.shift() ?? { points: [], next_page_offset: null };
  }
}

mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: MockQdrantClient,
}));

// Records the checkpoint clears `ensureSectionCollection` performs when it
// (re)creates an empty collection, so tests can assert the embed high-water is
// reset (which sends the next maintain pass down its full-corpus re-embed path).
// `ops` is the write log in order (`set:<key>` / `delete:<key>`), so the
// chunker-version tests can assert which write lands first.
const checkpointState = {
  deletes: [] as string[],
  ops: [] as string[],
  values: new Map<string, string>(),
  // Keys whose read or write throws, so the chunker-version tests can fail a
  // transition part-way through and assert what the hold does with it.
  throwOnGet: null as string | null,
  throwOnSet: null as string | null,
};
mock.module("../../../../../persistence/checkpoints.js", () => ({
  getMemoryCheckpoint: (key: string) => {
    if (checkpointState.throwOnGet === key) {
      throw new Error(`checkpoint read failed: ${key}`);
    }
    return checkpointState.values.get(key) ?? null;
  },
  setMemoryCheckpoint: (key: string, value: string) => {
    if (checkpointState.throwOnSet === key) {
      throw new Error(`checkpoint write failed: ${key}`);
    }
    checkpointState.ops.push(`set:${key}`);
    checkpointState.values.set(key, value);
  },
  deleteMemoryCheckpoint: (key: string) => {
    checkpointState.deletes.push(key);
    checkpointState.ops.push(`delete:${key}`);
    checkpointState.values.delete(key);
  },
}));

const {
  ensureSectionCollection,
  upsertSections,
  warmSectionEmbeddings,
  WARM_SECTIONS_PER_CALL,
  deleteSectionsForArticle,
  listSectionArticles,
  SECTION_COLLECTION,
  commitSectionEmbedHighWater,
  ensureSectionChunkerVersion,
  holdSectionDenseReadsUntilRebuilt,
  sectionDenseReadsHeld,
  settleSectionDenseReadHold,
  MAINTAIN_EMBED_HIGH_WATER_KEY,
  SECTION_CHUNKER_VERSION,
  SECTION_CHUNKER_VERSION_KEY,
  SECTION_REBUILD_PENDING_KEY,
  _resetSectionDenseStoreForTests,
} = await import("../section-dense-store.js");

const CONFIG = {
  memory: { qdrant: { vectorSize: 4, onDisk: true } },
} as unknown as AssistantConfig;

function section(
  article: string,
  ordinal: number,
  text: string,
  title = "",
): Section {
  return { article, ordinal, text, title };
}

function resetState(): void {
  state.collectionExists = false;
  state.collectionExistsCalls = 0;
  state.createCollectionCalls = 0;
  state.createCollectionParams = null;
  state.createIndexCalls.length = 0;
  state.upsertCalls.length = 0;
  state.deleteCalls.length = 0;
  state.createCollectionThrows = null;
  state.getCollectionCalls = 0;
  state.getCollectionInfo = MATCHING_SECTION_SCHEMA;
  state.getCollectionThrows = null;
  state.deleteCollectionCalls.length = 0;
  state.scrollPages.length = 0;
  state.scrollCalls.length = 0;
  state.scrollThrows = null;
  embedState.calls.length = 0;
  embedState.dim = 4;
  embedState.statusProvider = "local";
  embedState.statusModel = "test-model";
  embedState.embedProvider = "local";
  embedState.embedModel = "test-model";
  embedState.geminiTaskType = undefined;
  embedState.geminiDimensions = undefined;
  cacheState.store.clear();
  cacheState.reads.length = 0;
  checkpointState.deletes.length = 0;
  checkpointState.ops.length = 0;
  checkpointState.throwOnGet = null;
  checkpointState.throwOnSet = null;
  _resetSectionDenseStoreForTests();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("memory v3 section-dense-store — collection lifecycle", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("uses the documented collection name", () => {
    expect(SECTION_COLLECTION).toBe("memory_v3_sections");
  });

  test("creates the collection with a single dense vector at the configured dimension", async () => {
    state.collectionExists = false;

    await ensureSectionCollection(CONFIG);

    expect(state.createCollectionCalls).toBe(1);
    const params = state.createCollectionParams as {
      vectors: { size: number; distance: string; on_disk: boolean };
    };
    // Dimension comes from config.memory.qdrant.vectorSize, never hard-coded.
    expect(params.vectors).toEqual({
      size: 4,
      distance: "Cosine",
      on_disk: true,
    });
    // `article` payload index is created so delete-by-filter works in strict mode.
    expect(state.createIndexCalls).toEqual([
      { field_name: "article", field_schema: "keyword" },
    ]);
  });

  test("creates at whatever dimension the backend is configured for", async () => {
    const config = {
      memory: { qdrant: { vectorSize: 1536, onDisk: false } },
    } as unknown as AssistantConfig;

    await ensureSectionCollection(config);

    const params = state.createCollectionParams as {
      vectors: { size: number };
    };
    expect(params.vectors.size).toBe(1536);
  });

  test("ensures the article payload index when the collection already exists", async () => {
    state.collectionExists = true;

    await ensureSectionCollection(CONFIG);

    // No collection create, but the article payload index is ensured idempotently
    // so a collection left without it (e.g. an earlier crash between create and
    // index, under strict-mode Qdrant) self-heals on the next start.
    expect(state.createCollectionCalls).toBe(0);
    expect(state.createIndexCalls).toEqual([
      { field_name: "article", field_schema: "keyword" },
    ]);
  });

  test("recreates the collection on dimension drift (page-derived, repopulated by maintain)", async () => {
    state.collectionExists = true;
    // Existing collection sized to a different embedding dimension than the
    // configured 4 (e.g. a 384-dim collection from a prior model). The section
    // collection is page-derived and repopulated by the probe-gated
    // maintain/backfill, and the startup reconcile only repairs the v2
    // collection's dimension, so a v3-only drift is repaired here.
    state.getCollectionInfo = {
      config: { params: { vectors: { size: 384, distance: "Cosine" } } },
    };

    await ensureSectionCollection(CONFIG);

    expect(state.getCollectionCalls).toBe(1);
    expect(state.deleteCollectionCalls).toEqual([SECTION_COLLECTION]);
    expect(state.createCollectionCalls).toBe(1);
  });

  test("leaves a dimension-matched existing collection untouched", async () => {
    state.collectionExists = true;
    // Default getCollectionInfo (MATCHING_SECTION_SCHEMA) is size 4 === CONFIG.

    await ensureSectionCollection(CONFIG);

    expect(state.getCollectionCalls).toBe(1);
    expect(state.deleteCollectionCalls).toEqual([]);
    expect(state.createCollectionCalls).toBe(0);
  });

  test("treats a getCollection probe failure as compatible (no destructive recreate)", async () => {
    state.collectionExists = true;
    state.getCollectionThrows = new Error("transient REST error");

    await ensureSectionCollection(CONFIG);

    expect(state.deleteCollectionCalls).toEqual([]);
    expect(state.createCollectionCalls).toBe(0);
  });

  test("clears the embed high-water when recreating on dimension drift", async () => {
    state.collectionExists = true;
    state.getCollectionInfo = {
      config: { params: { vectors: { size: 384, distance: "Cosine" } } },
    };

    await ensureSectionCollection(CONFIG);

    // The recreate empties the collection, so the maintain checkpoint is reset:
    // the next pass re-embeds every page instead of only pages edited since.
    expect(state.deleteCollectionCalls).toEqual([SECTION_COLLECTION]);
    expect(checkpointState.deletes).toEqual([MAINTAIN_EMBED_HIGH_WATER_KEY]);
  });

  test("clears the embed high-water when creating a fresh collection", async () => {
    state.collectionExists = false;

    await ensureSectionCollection(CONFIG);

    expect(state.createCollectionCalls).toBe(1);
    expect(checkpointState.deletes).toEqual([MAINTAIN_EMBED_HIGH_WATER_KEY]);
  });

  test("leaves the embed high-water untouched when the collection is compatible", async () => {
    state.collectionExists = true;
    // MATCHING_SECTION_SCHEMA is size 4 === CONFIG, so no recreate happens.

    await ensureSectionCollection(CONFIG);

    expect(state.createCollectionCalls).toBe(0);
    expect(checkpointState.deletes).toEqual([]);
  });

  test("re-running ensure latches readiness (single existence probe)", async () => {
    state.collectionExists = false;

    await ensureSectionCollection(CONFIG);
    await ensureSectionCollection(CONFIG);

    expect(state.collectionExistsCalls).toBe(1);
    expect(state.createCollectionCalls).toBe(1);
  });

  test("treats a 409-on-create as success and still ensures the index", async () => {
    state.collectionExists = false;
    state.createCollectionThrows = Object.assign(new Error("Conflict"), {
      status: 409,
    });

    await ensureSectionCollection(CONFIG);

    // No throw; after the racing-peer 409 we fall through and still ensure the
    // article payload index (idempotent) rather than returning early.
    expect(state.createCollectionCalls).toBe(1);
    expect(state.createIndexCalls).toEqual([
      { field_name: "article", field_schema: "keyword" },
    ]);
  });
});

describe("memory v3 section-dense-store — upsert", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("embeds each section's text and upserts one point per section", async () => {
    state.collectionExists = true;
    const sections = [
      section("people/alice", 0, "alice lead text"),
      section("people/alice", 1, "alice section one", "History"),
      section("people/bob", 0, "bob lead text"),
    ];

    await upsertSections(CONFIG, sections);

    // Embedded exactly the section texts, in order.
    expect(embedState.calls).toEqual([
      ["alice lead text", "alice section one", "bob lead text"],
    ]);

    expect(state.upsertCalls).toHaveLength(1);
    const call = state.upsertCalls[0]!;
    expect(call.wait).toBe(true);
    expect(call.points).toHaveLength(3);

    expect(call.points.map((p) => p.payload)).toEqual([
      { article: "people/alice", ordinal: 0, title: "" },
      { article: "people/alice", ordinal: 1, title: "History" },
      { article: "people/bob", ordinal: 0, title: "" },
    ]);

    // Each point carries its matching embedding vector and a UUID-shaped id.
    for (const point of call.points) {
      expect(point.id).toMatch(UUID_RE);
      expect(point.vector).toHaveLength(4);
    }
    // Vectors are positional: section i gets backend vector i.
    expect(call.points[0]!.vector).toEqual([1, 2, 3, 4]);
    expect(call.points[1]!.vector).toEqual([2, 4, 6, 8]);
  });

  test("re-upserting the same sections is idempotent (stable point ids)", async () => {
    state.collectionExists = true;
    const sections = [section("people/alice", 0, "alice lead text")];

    await upsertSections(CONFIG, sections);
    await upsertSections(CONFIG, sections);

    expect(state.upsertCalls).toHaveLength(2);
    expect(state.upsertCalls[0]!.points[0]!.id).toBe(
      state.upsertCalls[1]!.points[0]!.id,
    );
  });

  test("distinct (article, ordinal) pairs map to distinct point ids", async () => {
    state.collectionExists = true;

    await upsertSections(CONFIG, [
      section("people/alice", 0, "x"),
      section("people/alice", 1, "y"),
      section("people/bob", 0, "z"),
    ]);

    const ids = state.upsertCalls[0]!.points.map((p) => p.id);
    expect(new Set(ids).size).toBe(3);
  });

  test("empty sections array is a no-op (no embedding, no upsert)", async () => {
    state.collectionExists = true;

    await upsertSections(CONFIG, []);

    expect(embedState.calls).toEqual([]);
    expect(state.upsertCalls).toHaveLength(0);
  });

  test("ensures the collection before upserting", async () => {
    state.collectionExists = false;

    await upsertSections(CONFIG, [section("people/alice", 0, "x")]);

    expect(state.createCollectionCalls).toBe(1);
    expect(state.upsertCalls).toHaveLength(1);
  });
});

describe("memory v3 section-dense-store — embedding cache", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("re-upserting unchanged sections serves from cache (no second embed)", async () => {
    state.collectionExists = true;
    const sections = [
      section("people/alice", 0, "alice lead text"),
      section("people/alice", 1, "alice section one"),
    ];

    await upsertSections(CONFIG, sections);
    expect(embedState.calls).toHaveLength(1); // cold cache → embedded once

    await upsertSections(CONFIG, sections);
    // No new backend call — the second pass reused both cached vectors.
    expect(embedState.calls).toHaveLength(1);
    // But the points were still upserted (rebuilt from cache), with identical
    // vectors to the first pass.
    expect(state.upsertCalls).toHaveLength(2);
    expect(state.upsertCalls[1]!.points.map((p) => p.vector)).toEqual(
      state.upsertCalls[0]!.points.map((p) => p.vector),
    );
  });

  test("warmSectionEmbeddings embeds every miss across pages in one backend call, and the per-page upserts then serve from cache", async () => {
    state.collectionExists = true;
    const alice = [
      section("people/alice", 0, "alice lead text"),
      section("people/alice", 1, "alice section one"),
    ];
    const bob = [section("people/bob", 0, "bob lead text")];

    await warmSectionEmbeddings(CONFIG, [...alice, ...bob]);
    expect(embedState.calls).toEqual([
      ["alice lead text", "alice section one", "bob lead text"],
    ]);
    expect(state.upsertCalls).toHaveLength(0);

    await upsertSections(CONFIG, alice);
    await upsertSections(CONFIG, bob);
    // No further backend call: both pages rebuilt their points from the cache.
    expect(embedState.calls).toHaveLength(1);
    expect(state.upsertCalls).toHaveLength(2);
    expect(
      state.upsertCalls.flatMap((c) => c.points).map((p) => p.vector),
    ).toEqual(
      [
        embedState.calls[0]!.map((_t, i) =>
          Array.from({ length: embedState.dim }, (_v, j) => (i + 1) * (j + 1)),
        ),
      ].flat(),
    );
  });

  test("warmSectionEmbeddings bounds each backend call to WARM_SECTIONS_PER_CALL sections", async () => {
    state.collectionExists = true;
    const count = WARM_SECTIONS_PER_CALL * 2 + 1;
    const sections = Array.from({ length: count }, (_v, i) =>
      section(`page-${Math.floor(i / 10)}`, i % 10, `text ${i}`),
    );

    await warmSectionEmbeddings(CONFIG, sections);

    expect(embedState.calls.map((c) => c.length)).toEqual([
      WARM_SECTIONS_PER_CALL,
      WARM_SECTIONS_PER_CALL,
      1,
    ]);
    expect(embedState.calls.flat()).toEqual(sections.map((s) => s.text));
  });

  test("warmSectionEmbeddings with no sections makes no backend call", async () => {
    await warmSectionEmbeddings(CONFIG, []);
    expect(embedState.calls).toHaveLength(0);
  });

  test("a changed section text re-embeds (content hash differs)", async () => {
    state.collectionExists = true;

    await upsertSections(CONFIG, [section("people/alice", 0, "text A")]);
    await upsertSections(CONFIG, [section("people/alice", 0, "text B")]);

    expect(embedState.calls).toEqual([["text A"], ["text B"]]);
  });

  test("partial hit embeds only the changed section, upserts both", async () => {
    state.collectionExists = true;
    await upsertSections(CONFIG, [
      section("people/alice", 0, "lead"),
      section("people/alice", 1, "one"),
    ]);
    embedState.calls.length = 0;

    await upsertSections(CONFIG, [
      section("people/alice", 0, "lead"), // unchanged → cache hit
      section("people/alice", 1, "one changed"), // changed → miss
    ]);

    // Only the changed section's text reached the backend.
    expect(embedState.calls).toEqual([["one changed"]]);
    // Both points (cached + freshly embedded) were upserted.
    expect(state.upsertCalls.at(-1)!.points).toHaveLength(2);
  });

  test("no resolved provider skips the cache and embeds every section", async () => {
    state.collectionExists = true;
    embedState.statusProvider = null;
    embedState.statusModel = null;

    await upsertSections(CONFIG, [
      section("people/alice", 0, "x"),
      section("people/alice", 1, "y"),
    ]);

    // Without an embedding identity the cache cannot be keyed, so it is never
    // read and every section is embedded — matching the pre-cache behavior.
    expect(cacheState.reads).toEqual([]);
    expect(embedState.calls).toEqual([["x", "y"]]);
  });

  test("a provider rotation re-embeds the whole batch under the new identity", async () => {
    state.collectionExists = true;
    await upsertSections(CONFIG, [
      section("people/alice", 0, "lead"),
      section("people/alice", 1, "one"),
    ]);
    embedState.calls.length = 0;

    // The cache-read identity still resolves to local/test-model (so section 0
    // is a hit), but the backend now answers as a different provider.
    embedState.embedProvider = "openai";
    embedState.embedModel = "text-embedding-3";

    await upsertSections(CONFIG, [
      section("people/alice", 0, "lead"), // hit under the old identity
      section("people/alice", 1, "one changed"), // miss
    ]);

    // First the misses are embedded; the rotated provider on that response
    // forces a full re-embed of every section so the collection stays in one
    // embedding space.
    expect(embedState.calls).toEqual([
      ["one changed"],
      ["lead", "one changed"],
    ]);
  });

  test("a Gemini task-type change re-embeds unchanged text (cache miss)", async () => {
    state.collectionExists = true;
    embedState.statusProvider = "gemini";
    embedState.statusModel = "gemini-embedding-2";
    embedState.embedProvider = "gemini";
    embedState.embedModel = "gemini-embedding-2";
    embedState.geminiTaskType = "RETRIEVAL_DOCUMENT";

    await upsertSections(CONFIG, [
      section("people/alice", 0, "alice lead text"),
    ]);
    expect(embedState.calls).toHaveLength(1); // cold cache → embedded once

    // Same text, same provider/model — but a different Gemini task type yields a
    // different vector, so the row cached under the old task type must not be
    // served. The extras are folded into the content hash, so the comparison
    // misses and the section re-embeds under the new task type.
    embedState.geminiTaskType = "SEMANTIC_SIMILARITY";

    await upsertSections(CONFIG, [
      section("people/alice", 0, "alice lead text"),
    ]);

    expect(embedState.calls).toEqual([
      ["alice lead text"],
      ["alice lead text"],
    ]);
  });

  test("an unchanged Gemini task type still serves from cache (no spurious miss)", async () => {
    state.collectionExists = true;
    embedState.statusProvider = "gemini";
    embedState.statusModel = "gemini-embedding-2";
    embedState.embedProvider = "gemini";
    embedState.embedModel = "gemini-embedding-2";
    embedState.geminiTaskType = "RETRIEVAL_DOCUMENT";

    const sections = [section("people/alice", 0, "alice lead text")];

    await upsertSections(CONFIG, sections);
    await upsertSections(CONFIG, sections);

    // Folding the extras into the hash must not break ordinary hits: with the
    // task type unchanged the second pass reuses the cached vector.
    expect(embedState.calls).toHaveLength(1);
    expect(state.upsertCalls).toHaveLength(2);
  });
});

describe("memory v3 section-dense-store — delete", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("deletes section points filtered by the article payload", async () => {
    state.collectionExists = true;

    await deleteSectionsForArticle(CONFIG, "people/alice");

    expect(state.deleteCalls).toHaveLength(1);
    const call = state.deleteCalls[0]!;
    expect(call.wait).toBe(true);
    expect(call.filter).toEqual({
      must: [{ key: "article", match: { value: "people/alice" } }],
    });
  });

  test("delete is idempotent across repeated calls", async () => {
    state.collectionExists = true;

    await deleteSectionsForArticle(CONFIG, "people/alice");
    await deleteSectionsForArticle(CONFIG, "people/alice");

    expect(state.deleteCalls).toHaveLength(2);
  });
});

describe("memory v3 section-dense-store — listSectionArticles", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("returns the distinct articles across all scrolled points", async () => {
    state.collectionExists = true;
    // Two scroll pages; `page-a` repeats within and across pages (one article,
    // many section points) — the result must be the DISTINCT article set.
    state.scrollPages = [
      {
        points: [
          { id: "1", payload: { article: "page-a" } },
          { id: "2", payload: { article: "page-a" } },
          { id: "3", payload: { article: "topic-x" } },
        ],
        next_page_offset: "cursor-1",
      },
      {
        points: [
          { id: "4", payload: { article: "page-a" } },
          { id: "5", payload: { article: "skills/example" } },
        ],
        next_page_offset: null,
      },
    ];

    const articles = await listSectionArticles(CONFIG);

    expect(new Set(articles)).toEqual(
      new Set(["page-a", "topic-x", "skills/example"]),
    );
    // Both pages were scrolled, and the second carried the prior page's cursor.
    expect(state.scrollCalls).toHaveLength(2);
    expect(state.scrollCalls[0]!.offset).toBeUndefined();
    expect(state.scrollCalls[1]!.offset).toBe("cursor-1");
  });

  test("skips points whose payload has no string article", async () => {
    state.collectionExists = true;
    state.scrollPages = [
      {
        points: [
          { id: "1", payload: { article: "page-a" } },
          { id: "2", payload: {} },
          { id: "3", payload: { article: 42 } },
        ],
        next_page_offset: null,
      },
    ];

    const articles = await listSectionArticles(CONFIG);

    expect(articles).toEqual(["page-a"]);
  });

  test("returns an empty list for an empty collection", async () => {
    state.collectionExists = true;
    state.scrollPages = [{ points: [], next_page_offset: null }];

    const articles = await listSectionArticles(CONFIG);

    expect(articles).toEqual([]);
  });
});

describe("memory v3 section-dense-store: chunker version guard", () => {
  const reset = () => {
    resetState();
    checkpointState.values.clear();
    checkpointState.ops.length = 0;
  };
  afterEach(() => {
    setSystemTime();
  });
  const HIGH_WATER = "1700000000000";
  const STORED_POINT = { id: "1", payload: { article: "page-a" } };
  const PROBE = [{ limit: 1, offset: undefined }];

  test("a recorded older version marks the rebuild pending before it clears the high-water, then records the version", async () => {
    reset();
    checkpointState.values.set(SECTION_CHUNKER_VERSION_KEY, "1");
    checkpointState.values.set(MAINTAIN_EMBED_HIGH_WATER_KEY, HIGH_WATER);

    expect(await ensureSectionChunkerVersion()).toBe(true);
    // The marker is the only signal that survives the reset, so it lands first.
    expect(checkpointState.ops).toEqual([
      `set:${SECTION_REBUILD_PENDING_KEY}`,
      `delete:${MAINTAIN_EMBED_HIGH_WATER_KEY}`,
      `set:${SECTION_CHUNKER_VERSION_KEY}`,
    ]);
    expect(checkpointState.values.get(SECTION_CHUNKER_VERSION_KEY)).toBe(
      String(SECTION_CHUNKER_VERSION),
    );
    // A recorded high-water already says "stale": the collection is not probed.
    expect(state.scrollCalls).toEqual([]);

    // A later check sees the recorded version, writes nothing, and keeps
    // reporting the rebuild pending until a clean pass commits.
    checkpointState.values.set(MAINTAIN_EMBED_HIGH_WATER_KEY, "1700000001000");
    checkpointState.ops.length = 0;
    expect(await ensureSectionChunkerVersion()).toBe(true);
    expect(checkpointState.ops).toEqual([]);
    expect(checkpointState.values.get(MAINTAIN_EMBED_HIGH_WATER_KEY)).toBe(
      "1700000001000",
    );
    commitSectionEmbedHighWater(1700000002000);
    expect(await ensureSectionChunkerVersion()).toBe(false);
  });

  test("an install that predates the version key (high-water present, no version) rebuilds once", async () => {
    reset();
    checkpointState.values.set(MAINTAIN_EMBED_HIGH_WATER_KEY, HIGH_WATER);

    expect(await ensureSectionChunkerVersion()).toBe(true);
    expect(checkpointState.deletes).toEqual([MAINTAIN_EMBED_HIGH_WATER_KEY]);
    expect(checkpointState.values.has(MAINTAIN_EMBED_HIGH_WATER_KEY)).toBe(
      false,
    );
    expect(checkpointState.values.get(SECTION_REBUILD_PENDING_KEY)).toBe("1");
    // Pending until the rebuild pass commits; a second check forces nothing new.
    expect(await ensureSectionChunkerVersion()).toBe(true);
    expect(checkpointState.deletes).toEqual([MAINTAIN_EMBED_HIGH_WATER_KEY]);
    commitSectionEmbedHighWater(1700000002000);
    expect(await ensureSectionChunkerVersion()).toBe(false);
  });

  test("a matching version writes nothing; a fresh install (empty collection) records the version without a rebuild", async () => {
    reset();
    checkpointState.values.set(
      SECTION_CHUNKER_VERSION_KEY,
      String(SECTION_CHUNKER_VERSION),
    );
    checkpointState.values.set(MAINTAIN_EMBED_HIGH_WATER_KEY, HIGH_WATER);
    expect(await ensureSectionChunkerVersion()).toBe(false);
    expect(checkpointState.ops).toEqual([]);
    expect(state.scrollCalls).toEqual([]);

    reset();
    // No version, no high-water, no marker: the collection decides, and an
    // empty one is a fresh install.
    expect(await ensureSectionChunkerVersion()).toBe(false);
    expect(state.scrollCalls).toEqual(PROBE);
    expect(checkpointState.ops).toEqual([`set:${SECTION_CHUNKER_VERSION_KEY}`]);
    expect(checkpointState.values.has(SECTION_REBUILD_PENDING_KEY)).toBe(false);
  });

  test("a forced rebuild marks the rebuild pending; committing the pass's high-water clears the marker", async () => {
    reset();
    checkpointState.values.set(SECTION_CHUNKER_VERSION_KEY, "1");
    checkpointState.values.set(MAINTAIN_EMBED_HIGH_WATER_KEY, HIGH_WATER);

    expect(await ensureSectionChunkerVersion()).toBe(true);
    expect(checkpointState.values.get(SECTION_REBUILD_PENDING_KEY)).toBe("1");

    commitSectionEmbedHighWater(1700000002000);
    expect(checkpointState.values.get(MAINTAIN_EMBED_HIGH_WATER_KEY)).toBe(
      "1700000002000",
    );
    expect(checkpointState.values.has(SECTION_REBUILD_PENDING_KEY)).toBe(false);
    expect(checkpointState.deletes).toEqual([
      MAINTAIN_EMBED_HIGH_WATER_KEY,
      SECTION_REBUILD_PENDING_KEY,
    ]);
  });

  test("a transition interrupted after the marker (high-water still present, version unrecorded) is finished by the next process with the hold on", async () => {
    reset();
    // The state a crash between the two transition writes leaves behind.
    checkpointState.values.set(SECTION_CHUNKER_VERSION_KEY, "1");
    checkpointState.values.set(SECTION_REBUILD_PENDING_KEY, "1");
    checkpointState.values.set(MAINTAIN_EMBED_HIGH_WATER_KEY, HIGH_WATER);

    // The fresh process holds reads and forces the rebuild: the high-water is
    // gone, the marker stays, the version is now on record.
    expect(await holdSectionDenseReadsUntilRebuilt()).toBe(true);
    expect(sectionDenseReadsHeld()).toBe(true);
    expect(checkpointState.values.has(MAINTAIN_EMBED_HIGH_WATER_KEY)).toBe(
      false,
    );
    expect(checkpointState.values.get(SECTION_REBUILD_PENDING_KEY)).toBe("1");
    expect(checkpointState.values.get(SECTION_CHUNKER_VERSION_KEY)).toBe(
      String(SECTION_CHUNKER_VERSION),
    );
  });

  test("a transition interrupted after the reset (marker set, high-water absent, version unrecorded) keeps the hold without probing the collection", async () => {
    reset();
    checkpointState.values.set(SECTION_CHUNKER_VERSION_KEY, "1");
    checkpointState.values.set(SECTION_REBUILD_PENDING_KEY, "1");

    expect(await holdSectionDenseReadsUntilRebuilt()).toBe(true);
    expect(state.scrollCalls).toEqual([]);
    expect(checkpointState.values.get(SECTION_REBUILD_PENDING_KEY)).toBe("1");
    expect(checkpointState.values.get(SECTION_CHUNKER_VERSION_KEY)).toBe(
      String(SECTION_CHUNKER_VERSION),
    );
  });

  test("a version-less store with no high-water or marker but points in the collection is stale, not fresh", async () => {
    reset();
    // No version, no high-water, no marker, yet points in the collection: an
    // install whose passes never committed cleanly. Nothing on the ledger
    // says "stale", so the collection probe has to.
    state.scrollPages = [{ points: [STORED_POINT], next_page_offset: null }];

    expect(await holdSectionDenseReadsUntilRebuilt()).toBe(true);
    expect(sectionDenseReadsHeld()).toBe(true);
    expect(state.scrollCalls).toEqual(PROBE);
    expect(checkpointState.values.get(SECTION_REBUILD_PENDING_KEY)).toBe("1");
    expect(checkpointState.values.get(SECTION_CHUNKER_VERSION_KEY)).toBe(
      String(SECTION_CHUNKER_VERSION),
    );
    // The rebuild pass's commit releases the hold as usual.
    commitSectionEmbedHighWater(1700000002000);
    expect(sectionDenseReadsHeld()).toBe(false);
    expect(await ensureSectionChunkerVersion()).toBe(false);
  });

  test("a collection probe that fails holds reads as indeterminate; the retried check finds the stale points, marks the rebuild, kicks it, and the commit releases", async () => {
    reset();
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    state.scrollThrows = new Error("qdrant unreachable");
    const kicks: number[] = [];

    // No version, no high-water, no marker: only the probe can say whether
    // the points are stale, and it cannot run. Held, nothing written, and
    // the check still owed.
    expect(
      await holdSectionDenseReadsUntilRebuilt(() => kicks.push(kicks.length)),
    ).toBe(true);
    expect(sectionDenseReadsHeld()).toBe(true);
    expect(checkpointState.ops).toEqual([]);
    expect(kicks).toEqual([]);
    // Already held: a later lane init in this process starts nothing new.
    expect(await holdSectionDenseReadsUntilRebuilt()).toBe(false);

    // Qdrant recovers with points built by the previous chunker. Inside the
    // cooldown the read path leaves the check alone.
    state.scrollThrows = null;
    state.scrollPages = [{ points: [STORED_POINT], next_page_offset: null }];
    expect(await settleSectionDenseReadHold()).toBe(true);
    expect(state.scrollCalls).toEqual(PROBE);

    // Past it, the retried check completes the transition the init check
    // could not: marker first, high-water reset, version recorded, and the
    // rebuild kicked through the callback lane init registered.
    setSystemTime(new Date("2026-01-01T00:01:00Z"));
    expect(await settleSectionDenseReadHold()).toBe(true);
    expect(state.scrollCalls).toEqual([...PROBE, ...PROBE]);
    expect(checkpointState.ops).toEqual([
      `set:${SECTION_REBUILD_PENDING_KEY}`,
      `delete:${MAINTAIN_EMBED_HIGH_WATER_KEY}`,
      `set:${SECTION_CHUNKER_VERSION_KEY}`,
    ]);
    expect(kicks).toEqual([0]);

    // Held for the rebuild now, so the marker governs the release.
    expect(sectionDenseReadsHeld()).toBe(true);
    commitSectionEmbedHighWater(1700000002000);
    expect(sectionDenseReadsHeld()).toBe(false);
    expect(await settleSectionDenseReadHold()).toBe(false);
  });

  test("a retried check that fails again keeps the hold and re-arms the cooldown, and overlapping reads share one retry", async () => {
    reset();
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    state.scrollThrows = new Error("qdrant unreachable");

    expect(await holdSectionDenseReadsUntilRebuilt()).toBe(true);

    setSystemTime(new Date("2026-01-01T00:01:00Z"));
    expect(
      await Promise.all([
        settleSectionDenseReadHold(),
        settleSectionDenseReadHold(),
      ]),
    ).toEqual([true, true]);
    // One retry for both reads, and it failed: still held, nothing written,
    // and the next minute is waited out before another probe.
    expect(state.scrollCalls).toEqual([...PROBE, ...PROBE]);
    expect(sectionDenseReadsHeld()).toBe(true);
    expect(await settleSectionDenseReadHold()).toBe(true);
    expect(state.scrollCalls).toHaveLength(2);
    expect(checkpointState.ops).toEqual([]);
  });

  test("a fresh install whose probe fails is held until the retried check records the version, then reads open with nothing pending", async () => {
    reset();
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    state.scrollThrows = new Error("qdrant unreachable");
    const kicks: number[] = [];

    expect(
      await holdSectionDenseReadsUntilRebuilt(() => kicks.push(kicks.length)),
    ).toBe(true);
    expect(sectionDenseReadsHeld()).toBe(true);

    // The probe finds the collection empty once it can run: a fresh install,
    // recorded as such, with nothing to rebuild and nothing to kick.
    state.scrollThrows = null;
    setSystemTime(new Date("2026-01-01T00:01:00Z"));
    expect(await settleSectionDenseReadHold()).toBe(false);
    expect(sectionDenseReadsHeld()).toBe(false);
    expect(checkpointState.ops).toEqual([`set:${SECTION_CHUNKER_VERSION_KEY}`]);
    expect(checkpointState.values.has(SECTION_REBUILD_PENDING_KEY)).toBe(false);
    expect(kicks).toEqual([]);
    expect(await ensureSectionChunkerVersion()).toBe(false);
  });

  test("a version check that fails after writing the marker holds dense reads, and the retried check finishes the transition", async () => {
    reset();
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    checkpointState.values.set(SECTION_CHUNKER_VERSION_KEY, "1");
    checkpointState.values.set(MAINTAIN_EMBED_HIGH_WATER_KEY, HIGH_WATER);
    checkpointState.throwOnSet = SECTION_CHUNKER_VERSION_KEY;
    const kicks: number[] = [];

    expect(
      await holdSectionDenseReadsUntilRebuilt(() => kicks.push(kicks.length)),
    ).toBe(true);
    expect(sectionDenseReadsHeld()).toBe(true);
    // The marker landed before the failure, so the durable state says stale,
    // while the failed write left the old version on record.
    expect(checkpointState.values.get(SECTION_REBUILD_PENDING_KEY)).toBe("1");
    expect(checkpointState.values.get(SECTION_CHUNKER_VERSION_KEY)).toBe("1");
    expect(kicks).toEqual([]);

    // The ledger takes writes again: the retried check repeats the
    // transition (the marker already says stale, so no probe), records the
    // version, and kicks the rebuild the marker names.
    checkpointState.throwOnSet = null;
    setSystemTime(new Date("2026-01-01T00:01:00Z"));
    expect(await settleSectionDenseReadHold()).toBe(true);
    expect(checkpointState.values.get(SECTION_CHUNKER_VERSION_KEY)).toBe(
      String(SECTION_CHUNKER_VERSION),
    );
    expect(state.scrollCalls).toEqual([]);
    expect(kicks).toEqual([0]);
    commitSectionEmbedHighWater(1700000002000);
    expect(sectionDenseReadsHeld()).toBe(false);
  });

  test("a version check that fails while the marker cannot be read holds dense reads until the ledger answers", async () => {
    reset();
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    checkpointState.values.set(SECTION_CHUNKER_VERSION_KEY, "1");
    checkpointState.throwOnGet = SECTION_REBUILD_PENDING_KEY;

    expect(await holdSectionDenseReadsUntilRebuilt()).toBe(true);
    expect(sectionDenseReadsHeld()).toBe(true);

    // The marker reads again, absent, with no high-water and an empty
    // collection: nothing pending, and the retried check opens reads.
    checkpointState.throwOnGet = null;
    setSystemTime(new Date("2026-01-01T00:01:00Z"));
    expect(await settleSectionDenseReadHold()).toBe(false);
    expect(sectionDenseReadsHeld()).toBe(false);
    expect(checkpointState.values.get(SECTION_CHUNKER_VERSION_KEY)).toBe(
      String(SECTION_CHUNKER_VERSION),
    );
  });

  test("a fresh install's version record marks nothing pending", async () => {
    reset();
    expect(await ensureSectionChunkerVersion()).toBe(false);
    expect(checkpointState.values.has(SECTION_REBUILD_PENDING_KEY)).toBe(false);
  });
});
