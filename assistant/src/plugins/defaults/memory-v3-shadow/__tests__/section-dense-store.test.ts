import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../../../__tests__/helpers/mock-logger.js";
import type { AssistantConfig } from "../../../../config/types.js";
import type { Section } from "../types.js";

mock.module("../../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

mock.module("../../../../memory/qdrant-client.js", () => ({
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

// Stub the shared embedding backend. Records inputs and returns one
// deterministic vector per input so `upsertSections` can map vectors → points.
const embedState = {
  calls: [] as string[][],
  dim: 4,
};
mock.module("../../../../memory/embedding-backend.js", () => ({
  embedWithBackend: async (_config: unknown, inputs: string[]) => {
    embedState.calls.push(inputs);
    return {
      provider: "local",
      model: "test-model",
      vectors: inputs.map((_input, i) =>
        Array.from({ length: embedState.dim }, (_v, j) => (i + 1) * (j + 1)),
      ),
    };
  },
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

const {
  ensureSectionCollection,
  upsertSections,
  deleteSectionsForArticle,
  listSectionArticles,
  SECTION_COLLECTION,
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

  test("recreates the collection when its dense vector dimension drifts", async () => {
    state.collectionExists = true;
    // Existing collection sized to a different embedding dimension than the
    // configured 4 (e.g. a 384-dim collection from a prior model). Every upsert
    // would fail with HTTP 400 until it is recreated; the next backfill
    // re-embeds the sections.
    state.getCollectionInfo = {
      config: { params: { vectors: { size: 384, distance: "Cosine" } } },
    };

    await ensureSectionCollection(CONFIG);

    expect(state.getCollectionCalls).toBe(1);
    expect(state.deleteCollectionCalls).toEqual([SECTION_COLLECTION]);
    expect(state.createCollectionCalls).toBe(1);
    // The recreated collection is sized to the configured dimension.
    const params = state.createCollectionParams as {
      vectors: { size: number };
    };
    expect(params.vectors.size).toBe(4);
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
