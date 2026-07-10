import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Per-suite tmp data dir so the reembed sentinel never lands in the
// developer's real ~/.vellum workspace.
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "memory-v2-qdrant-test-"));
const REEMBED_SENTINEL_PATH = join(
  TEST_DATA_DIR,
  ".memory-v2-reembed-required",
);

mock.module("../../../../../util/platform.js", () => ({
  getDataDir: () => TEST_DATA_DIR,
  // Bun shares mocked modules across test files; some peer tests import
  // `getWorkspaceDir` from this same module, so re-export it here to avoid
  // an `undefined` if this mock is the one that wins evaluation order.
  getWorkspaceDir: () => TEST_DATA_DIR,
  // Imported by the real util/logger.js; ESM named-import validation
  // requires it even though the silent test logger never calls it.
  getLogsDir: () => `${TEST_DATA_DIR}/logs`,
}));

// Stub getConfig — only the qdrant.url / vectorSize / onDisk fields matter.
mock.module("../../../../../config/loader.js", () => ({
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

mock.module("../../../../../persistence/embeddings/qdrant-client.js", () => ({
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

// Mock the underlying @qdrant/js-client-rest package. The mock client
// records every call and lets each test program the next response.
type MockPoint = {
  id: string;
  vector: {
    dense: number[];
    sparse: { indices: number[]; values: number[] };
    summary_dense?: number[];
    summary_sparse?: { indices: number[]; values: number[] };
  };
  payload: { slug: string; updated_at: number };
};

type MockCollectionInfo = {
  config: {
    params: {
      vectors?: Record<string, { size: number }> | { size: number };
      sparse_vectors?: Record<string, unknown>;
    };
  };
};

const FULL_SCHEMA_INFO: MockCollectionInfo = {
  config: {
    params: {
      vectors: {
        dense: { size: 384 },
        summary_dense: { size: 384 },
      },
      sparse_vectors: {
        sparse: { index: { on_disk: true } },
        summary_sparse: { index: { on_disk: true } },
      },
    },
  },
};

const state = {
  collectionExistsBeforeCreate: false,
  collectionExistsCalls: 0,
  createCollectionCalls: 0,
  createCollectionParams: null as unknown,
  createIndexCalls: [] as Array<{ field_name: string; field_schema: string }>,
  upsertCalls: [] as Array<{ wait: boolean; points: MockPoint[] }>,
  deleteCalls: [] as Array<{ wait: boolean; points: string[] }>,
  // Tracks `client.deleteCollection(name)` calls (distinct from `delete()`,
  // which targets points). The schema-drift recreate path drops the
  // collection entirely and we want to assert it ran exactly once.
  deleteCollectionCalls: [] as string[],
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
  // Tracks `client.updateCollection(name, params)` calls — the in-place
  // sparse-index placement reconcile issues these on the compatible path.
  updateCollectionCalls: [] as Array<{ name: string; params: unknown }>,
  updateCollectionThrows: null as Error | null,
  // Schema returned by `client.getCollection`. Tests that exercise the
  // drift path point this at a partial schema; the default mirrors a fully
  // migrated collection so the no-drift path is the silent default.
  getCollectionInfo: FULL_SCHEMA_INFO as MockCollectionInfo,
  getCollectionThrows: null as Error | null,
  getCollectionCalls: 0,
  // Point count returned by `client.count`. Used by `countConceptPagePoints`
  // which the lifecycle hook reads for the empty-after-create recovery path.
  countResult: 0,
  countThrows: null as Error | null,
  countCalls: 0,
  // Throw queue for upsert: first call shifts and throws if non-null;
  // subsequent calls succeed once the queue is exhausted.
  upsertThrowQueue: [] as Array<Error | null>,
  // Throw queue for createPayloadIndex: each entry maps to the next call,
  // so tests can simulate index-creation failures (strict-mode, network).
  createIndexThrowQueue: [] as Array<Error | null>,
};

class MockQdrantClient {
  constructor(_opts: unknown) {}
  async collectionExists(_name: string) {
    state.collectionExistsCalls++;
    return { exists: state.collectionExistsBeforeCreate };
  }
  async getCollection(_name: string) {
    state.getCollectionCalls++;
    if (state.getCollectionThrows) throw state.getCollectionThrows;
    return state.getCollectionInfo;
  }
  async createCollection(_name: string, params: unknown) {
    state.createCollectionCalls++;
    state.createCollectionParams = params;
    if (state.createCollectionThrows) throw state.createCollectionThrows;
    state.collectionExistsBeforeCreate = true;
    state.getCollectionInfo = FULL_SCHEMA_INFO;
    return {};
  }
  async deleteCollection(name: string) {
    state.deleteCollectionCalls.push(name);
    state.collectionExistsBeforeCreate = false;
    return {};
  }
  async updateCollection(name: string, params: unknown) {
    state.updateCollectionCalls.push({ name, params });
    if (state.updateCollectionThrows) throw state.updateCollectionThrows;
    return {};
  }
  async count(_name: string, _opts: { exact: boolean }) {
    state.countCalls++;
    if (state.countThrows) throw state.countThrows;
    return { count: state.countResult };
  }
  async createPayloadIndex(
    _name: string,
    params: { field_name: string; field_schema: string },
  ) {
    state.createIndexCalls.push(params);
    if (state.createIndexThrowQueue.length > 0) {
      const next = state.createIndexThrowQueue.shift();
      if (next) throw next;
    }
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
    // Both `dense` and `summary_dense` consume from the dense queue (and
    // similarly for sparse). The four-channel hybrid query fires them in
    // order: body-dense, body-sparse, summary-dense, summary-sparse — so
    // queue order matches call order.
    const queue =
      state.queryResponses[
        params.using.endsWith("sparse") ? "sparse" : "dense"
      ];
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
  countConceptPagePoints,
  clearReembedSentinel,
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
  state.deleteCollectionCalls.length = 0;
  state.queryCalls.length = 0;
  state.queryResponses.dense.length = 0;
  state.queryResponses.sparse.length = 0;
  state.createCollectionThrows = null;
  state.updateCollectionCalls.length = 0;
  state.updateCollectionThrows = null;
  state.getCollectionInfo = FULL_SCHEMA_INFO;
  state.getCollectionThrows = null;
  state.getCollectionCalls = 0;
  state.countResult = 0;
  state.countThrows = null;
  state.countCalls = 0;
  state.upsertThrowQueue.length = 0;
  state.createIndexThrowQueue.length = 0;
  _resetMemoryV2QdrantForTests();
  // Drop any sentinel a prior test left behind so the no-drift default path
  // doesn't accidentally report `migrated: true`.
  if (existsSync(REEMBED_SENTINEL_PATH)) {
    rmSync(REEMBED_SENTINEL_PATH);
  }
}

describe("memory v2 qdrant — collection lifecycle", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("creates the collection with named dense + sparse vectors (body and summary)", async () => {
    state.collectionExistsBeforeCreate = false;

    await ensureConceptPageCollection();

    expect(state.createCollectionCalls).toBe(1);
    const params = state.createCollectionParams as {
      vectors: {
        dense: { size: number; distance: string; on_disk: boolean };
        summary_dense: { size: number; distance: string; on_disk: boolean };
      };
      sparse_vectors: {
        sparse: Record<string, unknown>;
        summary_sparse: Record<string, unknown>;
      };
      hnsw_config: { on_disk: boolean; m: number; ef_construct: number };
      on_disk_payload: boolean;
    };
    expect(params.vectors.dense).toEqual({
      size: 384,
      distance: "Cosine",
      on_disk: true,
    });
    // Summary side mirrors body so the activation pipeline can fuse symmetrically.
    expect(params.vectors.summary_dense).toEqual({
      size: 384,
      distance: "Cosine",
      on_disk: true,
    });
    // Sparse inverted indexes follow the collection's on-disk setting instead
    // of Qdrant's in-RAM default.
    expect(params.sparse_vectors.sparse).toEqual({
      index: { on_disk: true },
    });
    expect(params.sparse_vectors.summary_sparse).toEqual({
      index: { on_disk: true },
    });
    expect(params.hnsw_config).toEqual({
      on_disk: true,
      m: 16,
      ef_construct: 100,
    });
    expect(params.on_disk_payload).toBe(true);

    // Slug + kind payload indexes are created up front.
    expect(state.createIndexCalls).toEqual([
      { field_name: "slug", field_schema: "keyword" },
      { field_name: "kind", field_schema: "keyword" },
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
    // cache; createCollection never ran. Payload indexes are (idempotently)
    // ensured on the existing-collection path to backfill long-lived installs
    // that predate the `kind` index.
    expect(state.createCollectionCalls).toBe(0);
    expect(state.createIndexCalls).toEqual([
      { field_name: "slug", field_schema: "keyword" },
      { field_name: "kind", field_schema: "keyword" },
    ]);
    expect(state.collectionExistsCalls).toBe(1);
    // The sparse indexes already sit on disk — no placement update issued.
    expect(state.updateCollectionCalls).toEqual([]);
  });

  test("moves in-RAM sparse indexes to disk on an existing compatible collection", async () => {
    // Collection created before sparse indexes carried an explicit placement:
    // full named-vector schema, but both sparse channels default to RAM.
    state.collectionExistsBeforeCreate = true;
    state.getCollectionInfo = {
      config: {
        params: {
          vectors: {
            dense: { size: 384 },
            summary_dense: { size: 384 },
          },
          sparse_vectors: { sparse: {}, summary_sparse: {} },
        },
      },
    };

    const result = await ensureConceptPageCollection();

    // In-place update only — no destructive recreate, no reembed owed.
    expect(result).toEqual({ migrated: false });
    expect(state.deleteCollectionCalls).toEqual([]);
    expect(state.createCollectionCalls).toBe(0);
    expect(state.updateCollectionCalls).toEqual([
      {
        name: MEMORY_V2_COLLECTION,
        params: {
          sparse_vectors: {
            sparse: { index: { on_disk: true } },
            summary_sparse: { index: { on_disk: true } },
          },
        },
      },
    ]);
  });

  test("only updates the sparse channels that drift", async () => {
    state.collectionExistsBeforeCreate = true;
    state.getCollectionInfo = {
      config: {
        params: {
          vectors: {
            dense: { size: 384 },
            summary_dense: { size: 384 },
          },
          sparse_vectors: {
            sparse: { index: { on_disk: true } },
            summary_sparse: {},
          },
        },
      },
    };

    await ensureConceptPageCollection();

    expect(state.updateCollectionCalls).toEqual([
      {
        name: MEMORY_V2_COLLECTION,
        params: {
          sparse_vectors: { summary_sparse: { index: { on_disk: true } } },
        },
      },
    ]);
  });

  test("a failed sparse-placement update does not block collection readiness", async () => {
    state.collectionExistsBeforeCreate = true;
    state.getCollectionInfo = {
      config: {
        params: {
          vectors: {
            dense: { size: 384 },
            summary_dense: { size: 384 },
          },
          sparse_vectors: { sparse: {}, summary_sparse: {} },
        },
      },
    };
    state.updateCollectionThrows = new Error("optimizer busy");

    const result = await ensureConceptPageCollection();

    // Best-effort: readiness latches and the collection keeps serving from
    // its current in-RAM indexes.
    expect(result).toEqual({ migrated: false });
    expect(state.updateCollectionCalls.length).toBe(1);

    // Readiness latched — a follow-up ensure is a pure cache hit.
    const again = await ensureConceptPageCollection();
    expect(again).toEqual({ migrated: false });
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
      { field_name: "kind", field_schema: "keyword" },
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

  test("detects missing summary_dense / summary_sparse on an existing collection and recreates", async () => {
    // Pre-#29823 schema: only body channels, no summary_*.
    state.collectionExistsBeforeCreate = true;
    state.getCollectionInfo = {
      config: {
        params: {
          vectors: { dense: { size: 384 } },
          sparse_vectors: { sparse: {} },
        },
      },
    };

    const result = await ensureConceptPageCollection();

    // Drift path probed once, dropped the collection once, and recreated
    // with the full four-vector schema (the create-success branch resets
    // `getCollectionInfo` to FULL_SCHEMA_INFO so a follow-up probe agrees).
    expect(state.getCollectionCalls).toBe(1);
    expect(state.deleteCollectionCalls).toEqual([MEMORY_V2_COLLECTION]);
    expect(state.createCollectionCalls).toBe(1);
    expect(result).toEqual({ migrated: true });

    // Recreated schema carries summary_dense + summary_sparse.
    const params = state.createCollectionParams as {
      vectors: Record<string, unknown>;
      sparse_vectors: Record<string, unknown>;
    };
    expect(params.vectors.summary_dense).toBeDefined();
    expect(params.sparse_vectors.summary_sparse).toBeDefined();
  });

  test("recreates when named vectors are missing AND sized wrong (schema drift wins)", async () => {
    // Both a missing summary channel AND a wrong dense dimension. The schema
    // recreate still wins: missing named vectors make the collection
    // unqueryable (HTTP 400) and the fix reproduces from disk, so the recreate
    // at the configured size repairs both at once.
    state.collectionExistsBeforeCreate = true;
    state.getCollectionInfo = {
      config: {
        params: {
          vectors: { dense: { size: 768 } },
          sparse_vectors: { sparse: {} },
        },
      },
    };

    const result = await ensureConceptPageCollection();

    expect(state.getCollectionCalls).toBe(1);
    expect(state.deleteCollectionCalls).toEqual([MEMORY_V2_COLLECTION]);
    expect(state.createCollectionCalls).toBe(1);
    expect(result).toEqual({ migrated: true });
  });

  test("leaves a wrong-dimension collection intact (defers to startup reconcile)", async () => {
    // All required named vectors PRESENT, but the dense channels are sized to a
    // different embedding dimension than the configured 384 (e.g. a 768-dim
    // collection from a prior embedding model). This lazy ensure runs on hot
    // upsert/query paths and cannot run an embed probe, so it must not destroy
    // the populated collection — the probe-gated startup reconcile owns
    // destructive dimension migration.
    state.collectionExistsBeforeCreate = true;
    state.getCollectionInfo = {
      config: {
        params: {
          vectors: { dense: { size: 768 }, summary_dense: { size: 768 } },
          sparse_vectors: { sparse: {}, summary_sparse: {} },
        },
      },
    };

    const result = await ensureConceptPageCollection();

    expect(state.getCollectionCalls).toBe(1);
    expect(state.deleteCollectionCalls).toEqual([]);
    expect(state.createCollectionCalls).toBe(0);
    expect(result).toEqual({ migrated: false });
  });

  test("leaves a fully migrated collection untouched", async () => {
    // Default `getCollectionInfo` is FULL_SCHEMA_INFO — already migrated.
    state.collectionExistsBeforeCreate = true;

    const result = await ensureConceptPageCollection();

    expect(state.getCollectionCalls).toBe(1);
    expect(state.deleteCollectionCalls).toEqual([]);
    expect(state.createCollectionCalls).toBe(0);
    expect(result).toEqual({ migrated: false });
  });

  test("getCollection failure is treated as compatible (no destructive recreate)", async () => {
    state.collectionExistsBeforeCreate = true;
    state.getCollectionThrows = new Error("transient REST error");

    const result = await ensureConceptPageCollection();

    expect(state.getCollectionCalls).toBe(1);
    expect(state.deleteCollectionCalls).toEqual([]);
    expect(state.createCollectionCalls).toBe(0);
    expect(result).toEqual({ migrated: false });
  });

  test("preserves the reembed signal across calls when createCollection fails after delete", async () => {
    // Pre-#29823 schema triggers the destructive recreate path.
    state.collectionExistsBeforeCreate = true;
    state.getCollectionInfo = {
      config: {
        params: {
          vectors: { dense: { size: 384 } },
          sparse_vectors: { sparse: {} },
        },
      },
    };
    state.createCollectionThrows = new Error("Qdrant transient failure");

    let firstError: unknown = null;
    try {
      await ensureConceptPageCollection();
    } catch (err) {
      firstError = err;
    }
    expect(firstError).not.toBeNull();
    // The sentinel must outlive the failed call so the retry knows data was lost.
    expect(existsSync(REEMBED_SENTINEL_PATH)).toBe(true);

    // Simulate a follow-up call after the transient failure clears. The
    // collection no longer exists (delete succeeded earlier) so the ensure
    // path falls through to createCollection without re-entering the drift
    // branch — but the sentinel must still surface as `migrated: true` so
    // the lifecycle hook enqueues reembed.
    state.createCollectionThrows = null;
    _resetMemoryV2QdrantForTests();
    const result = await ensureConceptPageCollection();

    expect(result).toEqual({ migrated: true });

    // Lifecycle hook clears the sentinel after enqueueing the reembed job.
    await clearReembedSentinel();
    expect(existsSync(REEMBED_SENTINEL_PATH)).toBe(false);
  });

  test("clearReembedSentinel is a no-op when no sentinel exists", async () => {
    // Idempotent: missing-file does not throw, so the lifecycle hook can
    // call it unconditionally without guarding.
    expect(existsSync(REEMBED_SENTINEL_PATH)).toBe(false);
    await clearReembedSentinel();
    expect(existsSync(REEMBED_SENTINEL_PATH)).toBe(false);
  });

  test("swallows 'already exists' on createPayloadIndex but propagates other failures without latching readiness", async () => {
    // Existing collection that already has the full schema — the ensure
    // path goes through `ensurePayloadIndexes` to backfill long-lived
    // installs. The first index call hits an "already exists" race
    // (benign; swallow); the second hits a strict-mode rejection (must
    // propagate so readiness is not latched).
    state.collectionExistsBeforeCreate = true;
    state.createIndexThrowQueue.push(
      Object.assign(
        new Error("Wrong input: Payload field 'slug' already exists"),
        { status: 400 },
      ),
      Object.assign(
        new Error(
          "Strict mode prohibits creating payload indexes on this deployment",
        ),
        { status: 400 },
      ),
    );

    let caught: unknown = null;
    try {
      await ensureConceptPageCollection();
    } catch (err) {
      caught = err;
    }
    expect((caught as Error | null)?.message).toMatch(/strict mode/i);

    // Both attempts ran; the strict-mode failure was not swallowed.
    expect(state.createIndexCalls).toEqual([
      { field_name: "slug", field_schema: "keyword" },
      { field_name: "kind", field_schema: "keyword" },
    ]);

    // Readiness must NOT be latched after a non-benign failure — otherwise
    // later slug/kind-filtered queries (e.g. skill backfill) would keep
    // failing until a daemon restart. A follow-up ensure must retry.
    const result = await ensureConceptPageCollection();
    expect(result).toEqual({ migrated: false });
    // Indexes attempted again on the retry (no throws queued this time).
    expect(state.createIndexCalls).toEqual([
      { field_name: "slug", field_schema: "keyword" },
      { field_name: "kind", field_schema: "keyword" },
      { field_name: "slug", field_schema: "keyword" },
      { field_name: "kind", field_schema: "keyword" },
    ]);
  });

  test("concurrent ensure during a schema rebuild only deletes/creates once", async () => {
    state.collectionExistsBeforeCreate = true;
    state.getCollectionInfo = {
      config: {
        params: {
          vectors: { dense: { size: 384 } },
          sparse_vectors: { sparse: {} },
        },
      },
    };

    const results = await Promise.all([
      ensureConceptPageCollection(),
      ensureConceptPageCollection(),
      ensureConceptPageCollection(),
    ]);

    expect(state.deleteCollectionCalls).toEqual([MEMORY_V2_COLLECTION]);
    expect(state.createCollectionCalls).toBe(1);
    // All three concurrent callers see the same migrated signal so any one
    // of them is safe to enqueue the reembed (the lifecycle hook is the
    // single producer in practice).
    expect(results).toEqual([
      { migrated: true },
      { migrated: true },
      { migrated: true },
    ]);
  });
});

describe("memory v2 qdrant — point count", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("returns the approximate Qdrant count for the v2 collection", async () => {
    state.collectionExistsBeforeCreate = true;
    state.countResult = 1185;

    const count = await countConceptPagePoints();

    expect(count).toBe(1185);
    expect(state.countCalls).toBe(1);
  });

  test("returns 0 when the count call fails (treated as needs-reembed)", async () => {
    state.collectionExistsBeforeCreate = true;
    state.countThrows = new Error("Qdrant unreachable");

    const count = await countConceptPagePoints();

    expect(count).toBe(0);
    expect(state.countCalls).toBe(1);
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
    // No summary vectors when caller didn't pass them — Qdrant accepts a
    // partial named-vector subset, and pages without a frontmatter summary
    // legitimately have nothing to embed on the summary side.
    const vectorRecord = point.vector as unknown as Record<string, unknown>;
    expect(vectorRecord.summary_dense).toBeUndefined();
    expect(vectorRecord.summary_sparse).toBeUndefined();
    // Point ID is a UUID-shaped string derived from the slug.
    expect(point.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("upserts summary vectors alongside body vectors when both are provided", async () => {
    state.collectionExistsBeforeCreate = true;

    await upsertConceptPageEmbedding({
      slug: "summarized-page",
      dense: [0.1, 0.2, 0.3],
      sparse: { indices: [1, 2], values: [0.5, 0.5] },
      summary: {
        dense: [0.4, 0.5, 0.6],
        sparse: { indices: [3, 4], values: [0.7, 0.7] },
      },
      updatedAt: 1714000000000,
    });

    expect(state.upsertCalls).toHaveLength(1);
    const [point] = state.upsertCalls[0].points;
    const vectorRecord = point.vector as unknown as Record<string, unknown>;
    expect(vectorRecord.dense).toEqual([0.1, 0.2, 0.3]);
    expect(vectorRecord.sparse).toEqual({
      indices: [1, 2],
      values: [0.5, 0.5],
    });
    expect(vectorRecord.summary_dense).toEqual([0.4, 0.5, 0.6]);
    expect(vectorRecord.summary_sparse).toEqual({
      indices: [3, 4],
      values: [0.7, 0.7],
    });
  });

  test("omits summary vectors when the summary block is undefined", async () => {
    // The grouped-shape signature enforces summary as a paired { dense, sparse }
    // block; passing `undefined` (or omitting it) leaves the summary vectors off
    // the point entirely so query-time fusion stays symmetric.
    state.collectionExistsBeforeCreate = true;

    await upsertConceptPageEmbedding({
      slug: "no-summary",
      dense: [0.1],
      sparse: { indices: [1], values: [1] },
      // summary intentionally omitted
      updatedAt: 1,
    });

    const [point] = state.upsertCalls[0].points;
    const vectorRecord = point.vector as unknown as Record<string, unknown>;
    expect(vectorRecord.summary_dense).toBeUndefined();
    expect(vectorRecord.summary_sparse).toBeUndefined();
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

  test("runs all four channels (body dense/sparse + summary dense/sparse) and returns per-channel scores", async () => {
    state.collectionExistsBeforeCreate = true;
    // Body channel hits.
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
    // Summary channel hits — queue order is body-dense, body-sparse,
    // summary-dense, summary-sparse, so push summaries after bodies.
    state.queryResponses.dense.push({
      points: [{ score: 0.81, payload: { slug: "alice-prefers-vs-code" } }],
    });
    state.queryResponses.sparse.push({
      points: [{ score: 9, payload: { slug: "alice-prefers-vs-code" } }],
    });

    const results = await hybridQueryConceptPages(
      [0.1, 0.2, 0.3],
      { indices: [1, 2], values: [0.5, 0.5] },
      5,
    );

    // All four queries fired with the same limit and distinct `using`.
    expect(state.queryCalls).toHaveLength(4);
    const usings = state.queryCalls.map((c) => c.using).sort();
    expect(usings).toEqual([
      "dense",
      "sparse",
      "summary_dense",
      "summary_sparse",
    ]);
    expect(state.queryCalls.every((c) => c.limit === 5)).toBe(true);
    expect(state.queryCalls.every((c) => c.with_payload === true)).toBe(true);

    // Alice has hits on all four channels; bob is body-only.
    expect(results).toHaveLength(2);
    const alice = results.find((r) => r.slug === "alice-prefers-vs-code");
    const bob = results.find((r) => r.slug === "bob-uses-zsh");
    expect(alice).toEqual({
      slug: "alice-prefers-vs-code",
      denseScore: 0.91,
      sparseScore: 12,
      summaryDenseScore: 0.81,
      summarySparseScore: 9,
    });
    expect(bob).toEqual({
      slug: "bob-uses-zsh",
      denseScore: 0.42,
      sparseScore: 3,
    });
  });

  test("dense-only hits leave sparseScore undefined (and vice versa)", async () => {
    state.collectionExistsBeforeCreate = true;
    // Body dense + sparse hits. Summary channels stay empty (no push) →
    // they fall through to `{ points: [] }` and produce no summary scores.
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
    expect(denseOnly?.summaryDenseScore).toBeUndefined();
    expect(sparseOnly).toEqual({ slug: "sparse-only", sparseScore: 2 });
    expect(sparseOnly?.denseScore).toBeUndefined();
    expect(sparseOnly?.summarySparseScore).toBeUndefined();
  });

  test("returns summary-channel scores when only the summary side hits", async () => {
    // Page has no body hits but matches via the summary embedding —
    // exercises the path where `simBatch` falls back to summary-only.
    state.collectionExistsBeforeCreate = true;
    // Body channels empty.
    state.queryResponses.dense.push({ points: [] });
    state.queryResponses.sparse.push({ points: [] });
    // Summary channels hit.
    state.queryResponses.dense.push({
      points: [{ score: 0.6, payload: { slug: "summary-only" } }],
    });
    state.queryResponses.sparse.push({
      points: [{ score: 4, payload: { slug: "summary-only" } }],
    });

    const results = await hybridQueryConceptPages(
      [0.1],
      { indices: [1], values: [1] },
      5,
    );

    const summaryOnly = results.find((r) => r.slug === "summary-only");
    expect(summaryOnly).toEqual({
      slug: "summary-only",
      summaryDenseScore: 0.6,
      summarySparseScore: 4,
    });
    expect(summaryOnly?.denseScore).toBeUndefined();
    expect(summaryOnly?.sparseScore).toBeUndefined();
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

  test("an empty dense vector runs a sparse-only query (skips the dense channels)", async () => {
    state.collectionExistsBeforeCreate = true;
    // Only the two sparse channels should fire. Queue body + summary sparse hits.
    state.queryResponses.sparse.push({
      points: [{ score: 7, payload: { slug: "people/alice" } }],
    });
    state.queryResponses.sparse.push({
      points: [{ score: 5, payload: { slug: "people/alice" } }],
    });

    const results = await hybridQueryConceptPages(
      [],
      { indices: [1, 2], values: [0.5, 0.5] },
      5,
    );

    // Regression: a 0-dimension dense vector used to be forwarded verbatim,
    // drawing a Qdrant "Vector dimension error: expected dim N, got 0" 400.
    // It must now skip the dense channels entirely — only sparse runs.
    const usings = state.queryCalls.map((c) => c.using).sort();
    expect(usings).toEqual(["sparse", "summary_sparse"]);
    expect(state.queryCalls.some((c) => c.using === "dense")).toBe(false);
    expect(state.queryCalls.some((c) => c.using === "summary_dense")).toBe(
      false,
    );

    // The sparse hits still come back; the dense score stays undefined.
    const alice = results.find((r) => r.slug === "people/alice");
    expect(alice).toEqual({
      slug: "people/alice",
      sparseScore: 7,
      summarySparseScore: 5,
    });
    expect(alice?.denseScore).toBeUndefined();
  });
});
