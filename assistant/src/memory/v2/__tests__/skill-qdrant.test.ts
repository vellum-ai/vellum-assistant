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
  payload: {
    id: string;
    content: string;
    updated_at: number;
  };
};

type ScrollPoint = {
  id: string | number;
  payload: Record<string, unknown>;
};

const state = {
  collectionExistsBeforeCreate: false,
  collectionExistsCalls: 0,
  createCollectionCalls: 0,
  createCollectionParams: null as unknown,
  createIndexCalls: [] as Array<{ field_name: string; field_schema: string }>,
  upsertCalls: [] as Array<{ wait: boolean; points: MockPoint[] }>,
  deleteCalls: [] as Array<{
    wait: boolean;
    points: Array<string | number>;
  }>,
  queryCalls: [] as Array<{
    using: string;
    query: unknown;
    limit: number;
    with_payload: boolean;
    filter?: unknown;
  }>,
  scrollCalls: [] as Array<{
    limit?: number;
    offset?: string | number;
    with_payload: boolean;
    with_vector: boolean;
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
  // Pages of scroll results returned in order; each call shifts one. Each
  // page may set `next_page_offset` to keep paginating.
  scrollPages: [] as Array<{
    points: ScrollPoint[];
    next_page_offset?: string | number | null;
  }>,
  createCollectionThrows: null as Error | null,
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
    state.upsertCalls.push(params);
    return {};
  }
  async delete(
    _name: string,
    params: { wait: boolean; points: Array<string | number> },
  ) {
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
      filter?: unknown;
    },
  ) {
    state.queryCalls.push(params);
    const queue = state.queryResponses[params.using as "dense" | "sparse"];
    return queue.shift() ?? { points: [] };
  }
  async scroll(
    _name: string,
    params: {
      limit?: number;
      offset?: string | number;
      with_payload: boolean;
      with_vector: boolean;
    },
  ) {
    state.scrollCalls.push(params);
    const page = state.scrollPages.shift();
    return page ?? { points: [], next_page_offset: null };
  }
}

mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: MockQdrantClient,
}));

const {
  ensureSkillCollection,
  upsertSkillEmbedding,
  pruneSkillsExcept,
  hybridQuerySkills,
  MEMORY_V2_SKILLS_COLLECTION,
  SKILL_NAMESPACE,
  _resetMemoryV2SkillQdrantForTests,
} = await import("../skill-qdrant.js");
const { MEMORY_V2_COLLECTION } = await import("../qdrant.js");

function resetState(): void {
  state.collectionExistsBeforeCreate = false;
  state.collectionExistsCalls = 0;
  state.createCollectionCalls = 0;
  state.createCollectionParams = null;
  state.createIndexCalls.length = 0;
  state.upsertCalls.length = 0;
  state.deleteCalls.length = 0;
  state.queryCalls.length = 0;
  state.scrollCalls.length = 0;
  state.queryResponses.dense.length = 0;
  state.queryResponses.sparse.length = 0;
  state.scrollPages.length = 0;
  state.createCollectionThrows = null;
  _resetMemoryV2SkillQdrantForTests();
}

describe("memory v2 skill qdrant — collection identity", () => {
  test("uses the documented collection name", () => {
    expect(MEMORY_V2_SKILLS_COLLECTION).toBe("memory_v2_skills");
  });

  test("collection name is distinct from the concept-page collection", () => {
    expect(MEMORY_V2_SKILLS_COLLECTION).not.toBe(MEMORY_V2_COLLECTION);
  });

  test("namespace is a valid UUID distinct from the concept-page namespace", () => {
    expect(SKILL_NAMESPACE).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // SLUG_NAMESPACE in qdrant.ts is "8b9c5d4f-0e1a-4f3b-9c2d-7e8f1a2b3c4d";
    // we deliberately picked a different one so an id-vs-slug collision
    // across collections doesn't produce the same point ID.
    expect(SKILL_NAMESPACE).not.toBe("8b9c5d4f-0e1a-4f3b-9c2d-7e8f1a2b3c4d");
  });
});

describe("memory v2 skill qdrant — collection lifecycle", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("creates the collection with named dense + sparse vectors", async () => {
    state.collectionExistsBeforeCreate = false;

    await ensureSkillCollection();

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

    // The id payload index is created up front, mirroring how the
    // concept-page collection eagerly indexes `slug`.
    expect(state.createIndexCalls).toEqual([
      { field_name: "id", field_schema: "keyword" },
    ]);
  });

  test("re-running ensure on an existing collection is a no-op", async () => {
    state.collectionExistsBeforeCreate = true;

    await ensureSkillCollection();
    await ensureSkillCollection();

    // Existence check fired exactly once thanks to the in-memory readiness
    // cache; createCollection / createPayloadIndex never ran.
    expect(state.createCollectionCalls).toBe(0);
    expect(state.createIndexCalls).toEqual([]);
    expect(state.collectionExistsCalls).toBe(1);
  });

  test("treats 409-on-create as success (concurrent creation race)", async () => {
    state.collectionExistsBeforeCreate = false;
    const conflict = Object.assign(new Error("Conflict"), { status: 409 });
    state.createCollectionThrows = conflict;

    await ensureSkillCollection();

    // Falls through without throwing — collectionReady gets latched.
    expect(state.createCollectionCalls).toBe(1);
    // Index creation is skipped on the 409 path because the racing peer is
    // expected to have created it (it ran the same code).
    expect(state.createIndexCalls).toEqual([]);
  });
});

describe("memory v2 skill qdrant — upsert", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("upserts a single point keyed by a deterministic id-derived point id", async () => {
    state.collectionExistsBeforeCreate = true;

    await upsertSkillEmbedding({
      id: "example-skill-1",
      content: "The Example Skill 1 (example-skill-1) is available. ...",
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
      id: "example-skill-1",
      content: "The Example Skill 1 (example-skill-1) is available. ...",
      updated_at: 1714000000000,
    });
    expect(point.vector.dense).toEqual([0.1, 0.2, 0.3]);
    expect(point.vector.sparse).toEqual({
      indices: [1, 2],
      values: [0.5, 0.5],
    });
    // Point ID is a UUID-shaped string derived from the skill id.
    expect(point.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("two upserts for the same id share the same point id (overwrites in place)", async () => {
    state.collectionExistsBeforeCreate = true;

    await upsertSkillEmbedding({
      id: "example-skill-1",
      content: "first",
      dense: [0.1],
      sparse: { indices: [1], values: [1] },
      updatedAt: 1,
    });
    await upsertSkillEmbedding({
      id: "example-skill-1",
      content: "second",
      dense: [0.9],
      sparse: { indices: [9], values: [0.5] },
      updatedAt: 2,
    });

    expect(state.upsertCalls).toHaveLength(2);
    expect(state.upsertCalls[0].points[0].id).toBe(
      state.upsertCalls[1].points[0].id,
    );
  });

  test("different ids map to different point ids", async () => {
    state.collectionExistsBeforeCreate = true;

    await upsertSkillEmbedding({
      id: "example-skill-1",
      content: "a",
      dense: [0.1],
      sparse: { indices: [1], values: [1] },
      updatedAt: 1,
    });
    await upsertSkillEmbedding({
      id: "example-skill-2",
      content: "b",
      dense: [0.1],
      sparse: { indices: [1], values: [1] },
      updatedAt: 1,
    });

    expect(state.upsertCalls[0].points[0].id).not.toBe(
      state.upsertCalls[1].points[0].id,
    );
  });
});

describe("memory v2 skill qdrant — prune", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("removes points whose payload.id is not in the active set", async () => {
    state.collectionExistsBeforeCreate = true;
    state.scrollPages.push({
      points: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          payload: { id: "example-skill-1" },
        },
        {
          id: "22222222-2222-2222-2222-222222222222",
          payload: { id: "example-skill-2" },
        },
      ],
      next_page_offset: null,
    });

    await pruneSkillsExcept(["example-skill-1"]);

    // One scroll, one batch delete carrying only the stale point id.
    expect(state.scrollCalls).toHaveLength(1);
    expect(state.deleteCalls).toHaveLength(1);
    expect(state.deleteCalls[0].wait).toBe(true);
    expect(state.deleteCalls[0].points).toEqual([
      "22222222-2222-2222-2222-222222222222",
    ]);
  });

  test("no-op delete when every live point is in the active set", async () => {
    state.collectionExistsBeforeCreate = true;
    state.scrollPages.push({
      points: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          payload: { id: "example-skill-1" },
        },
      ],
      next_page_offset: null,
    });

    await pruneSkillsExcept(["example-skill-1"]);

    expect(state.scrollCalls).toHaveLength(1);
    expect(state.deleteCalls).toHaveLength(0);
  });

  test("paginates via scroll's next_page_offset until exhausted", async () => {
    state.collectionExistsBeforeCreate = true;
    state.scrollPages.push({
      points: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          payload: { id: "example-skill-1" },
        },
      ],
      next_page_offset: "next-token",
    });
    state.scrollPages.push({
      points: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          payload: { id: "example-skill-2" },
        },
      ],
      next_page_offset: null,
    });

    await pruneSkillsExcept(["example-skill-1"]);

    // Two scrolls, the second carrying the offset returned by the first.
    expect(state.scrollCalls).toHaveLength(2);
    expect(state.scrollCalls[0].offset).toBeUndefined();
    expect(state.scrollCalls[1].offset).toBe("next-token");
    // Only the stale point gets deleted.
    expect(state.deleteCalls).toHaveLength(1);
    expect(state.deleteCalls[0].points).toEqual([
      "22222222-2222-2222-2222-222222222222",
    ]);
  });

  test("ignores points missing a string payload.id", async () => {
    state.collectionExistsBeforeCreate = true;
    state.scrollPages.push({
      points: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          payload: {}, // no id field at all
        },
        {
          id: "22222222-2222-2222-2222-222222222222",
          payload: { id: 42 }, // wrong type
        },
        {
          id: "33333333-3333-3333-3333-333333333333",
          payload: { id: "example-skill-2" },
        },
      ],
      next_page_offset: null,
    });

    await pruneSkillsExcept(["example-skill-1"]);

    // Only the well-typed stale id is deleted; malformed payloads are
    // ignored rather than treated as "stale".
    expect(state.deleteCalls).toHaveLength(1);
    expect(state.deleteCalls[0].points).toEqual([
      "33333333-3333-3333-3333-333333333333",
    ]);
  });

  test("idempotent across repeated calls with the same active set", async () => {
    state.collectionExistsBeforeCreate = true;
    state.scrollPages.push({
      points: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          payload: { id: "example-skill-1" },
        },
      ],
      next_page_offset: null,
    });
    state.scrollPages.push({
      points: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          payload: { id: "example-skill-1" },
        },
      ],
      next_page_offset: null,
    });

    await pruneSkillsExcept(["example-skill-1"]);
    await pruneSkillsExcept(["example-skill-1"]);

    // Both runs scrolled; neither deleted because the live set matches.
    expect(state.scrollCalls).toHaveLength(2);
    expect(state.deleteCalls).toHaveLength(0);
  });
});

describe("memory v2 skill qdrant — hybrid query", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("runs both dense and sparse queries and returns per-channel scores", async () => {
    state.collectionExistsBeforeCreate = true;
    state.queryResponses.dense.push({
      points: [
        { score: 0.91, payload: { id: "example-skill-1" } },
        { score: 0.42, payload: { id: "example-skill-2" } },
      ],
    });
    state.queryResponses.sparse.push({
      points: [
        { score: 12, payload: { id: "example-skill-1" } },
        { score: 3, payload: { id: "example-skill-2" } },
      ],
    });

    const results = await hybridQuerySkills(
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

    // Each id exposes both channel scores.
    expect(results).toHaveLength(2);
    const skill1 = results.find((r) => r.id === "example-skill-1");
    const skill2 = results.find((r) => r.id === "example-skill-2");
    expect(skill1).toEqual({
      id: "example-skill-1",
      denseScore: 0.91,
      sparseScore: 12,
    });
    expect(skill2).toEqual({
      id: "example-skill-2",
      denseScore: 0.42,
      sparseScore: 3,
    });
  });

  test("dense-only hits leave sparseScore undefined (and vice versa)", async () => {
    state.collectionExistsBeforeCreate = true;
    state.queryResponses.dense.push({
      points: [{ score: 0.7, payload: { id: "example-skill-1" } }],
    });
    state.queryResponses.sparse.push({
      points: [{ score: 2, payload: { id: "example-skill-2" } }],
    });

    const results = await hybridQuerySkills(
      [0.1],
      { indices: [1], values: [1] },
      5,
    );

    const denseOnly = results.find((r) => r.id === "example-skill-1");
    const sparseOnly = results.find((r) => r.id === "example-skill-2");
    expect(denseOnly).toEqual({ id: "example-skill-1", denseScore: 0.7 });
    expect(denseOnly?.sparseScore).toBeUndefined();
    expect(sparseOnly).toEqual({ id: "example-skill-2", sparseScore: 2 });
    expect(sparseOnly?.denseScore).toBeUndefined();
  });

  test("does not use Qdrant-side RRF fusion (separate per-channel queries)", async () => {
    state.collectionExistsBeforeCreate = true;
    state.queryResponses.dense.push({ points: [] });
    state.queryResponses.sparse.push({ points: [] });

    await hybridQuerySkills([0.1], { indices: [1], values: [1] }, 5);

    // Each query is a single-channel call (no `prefetch` + `fusion` shape).
    for (const call of state.queryCalls) {
      expect(call).not.toHaveProperty("prefetch");
      const wholeCall = call as unknown as Record<string, unknown>;
      expect(wholeCall.fusion).toBeUndefined();
    }
  });

  test("undefined restrictToIds queries the full catalog (no filter)", async () => {
    state.collectionExistsBeforeCreate = true;
    state.queryResponses.dense.push({
      points: [{ score: 0.5, payload: { id: "example-skill-1" } }],
    });
    state.queryResponses.sparse.push({
      points: [{ score: 1, payload: { id: "example-skill-2" } }],
    });

    const results = await hybridQuerySkills(
      [0.1],
      { indices: [1], values: [1] },
      5,
    );

    // Both channels ran without any payload filter.
    expect(state.queryCalls).toHaveLength(2);
    for (const call of state.queryCalls) {
      expect(call.filter).toBeUndefined();
    }
    // Full results flow through unchanged.
    expect(results.map((r) => r.id).sort()).toEqual([
      "example-skill-1",
      "example-skill-2",
    ]);
  });

  test("restrictToIds forwards a Qdrant id-IN filter to BOTH channels", async () => {
    state.collectionExistsBeforeCreate = true;
    state.queryResponses.dense.push({ points: [] });
    state.queryResponses.sparse.push({ points: [] });

    await hybridQuerySkills([0.1], { indices: [1], values: [1] }, 5, [
      "example-skill-a",
      "example-skill-b",
    ]);

    expect(state.queryCalls).toHaveLength(2);
    const usings = state.queryCalls.map((c) => c.using).sort();
    expect(usings).toEqual(["dense", "sparse"]);
    for (const call of state.queryCalls) {
      // Filter is forwarded to both dense and sparse — without this the
      // sparse channel would still grab the global top-K and corrupt
      // candidate scoring.
      expect(call.filter).toEqual({
        must: [
          { key: "id", match: { any: ["example-skill-a", "example-skill-b"] } },
        ],
      });
    }
  });

  test("empty restrictToIds short-circuits without hitting Qdrant", async () => {
    state.collectionExistsBeforeCreate = true;

    const results = await hybridQuerySkills(
      [0.1],
      { indices: [1], values: [1] },
      5,
      [],
    );

    expect(results).toEqual([]);
    // No Qdrant calls were made — the function returned before
    // ensureSkillCollection ran.
    expect(state.queryCalls).toHaveLength(0);
    expect(state.collectionExistsCalls).toBe(0);
  });

  test("empty Qdrant responses yield []", async () => {
    state.collectionExistsBeforeCreate = true;
    state.queryResponses.dense.push({ points: [] });
    state.queryResponses.sparse.push({ points: [] });

    const results = await hybridQuerySkills(
      [0.1],
      { indices: [1], values: [1] },
      5,
    );
    expect(results).toEqual([]);
  });
});
