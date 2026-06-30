import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../../../../__tests__/helpers/mock-logger.js";
import type { AssistantConfig } from "../../../../../config/types.js";
import type { Section } from "../types.js";

mock.module("../../../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

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
    if (!row || row.dimensions !== key.expectedDim) return null;
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
    if (state.createCollectionThrows) throw state.createCollectionThrows;
    state.collectionExists = true;
    return {};
  }
  async getCollection(_name: string) {
    state.getCollectionCalls++;
    if (state.getCollectionThrows) throw state.getCollectionThrows;
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
    return state.scrollPages.shift() ?? { points: [], next_page_offset: null };
  }
}

mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: MockQdrantClient,
}));

// Records the checkpoint clears `ensureSectionCollection` performs when it
// (re)creates an empty collection, so tests can assert the embed high-water is
// reset (which sends the next maintain pass down its full-corpus re-embed path).
const checkpointState = { deletes: [] as string[] };
mock.module("../../../../../persistence/checkpoints.js", () => ({
  getMemoryCheckpoint: () => null,
  setMemoryCheckpoint: () => undefined,
  deleteMemoryCheckpoint: (key: string) => {
    checkpointState.deletes.push(key);
  },
}));

const {
  ensureSectionCollection,
  upsertSections,
  deleteSectionsForArticle,
  listSectionArticles,
  SECTION_COLLECTION,
  MAINTAIN_EMBED_HIGH_WATER_KEY,
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
