import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SparseEmbedding } from "../embedding-types.js";

// ---------------------------------------------------------------------------
// Boundary mocks. This file runs in its own Bun process (see scripts/test.ts),
// so mock.module here cannot leak into other test files. The fake Qdrant
// honors the same (target_type, target_id, plugin) scoping the real client
// enforces, so cross-plugin isolation is actually exercised.
// ---------------------------------------------------------------------------

interface StoredPoint {
  target_type: string;
  target_id: string;
  plugin?: string;
  [k: string]: unknown;
}
interface UpsertCall {
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  sparse?: SparseEmbedding;
}

const calls = {
  upserts: [] as UpsertCall[],
  hybrid: [] as Array<{ filter?: unknown }>,
  search: [] as Array<{ limit: number; filter: unknown }>,
  get: [] as Array<{ targetId: string; plugin?: string }>,
  deleteScoped: [] as Array<{ targetId: string; plugin: string }>,
  deletePlugin: [] as string[],
};
// Keyed by the (globally unique, namespace-qualified) target_id.
const store = new Map<string, StoredPoint>();

/** Extract a matched value for `key` from a Qdrant-style must filter. */
function mustValue(filter: unknown, key: string): unknown {
  const must =
    (filter as { must?: Array<Record<string, unknown>> })?.must ?? [];
  for (const cond of must) {
    if (cond.key === key) {
      return (cond.match as { value?: unknown } | undefined)?.value;
    }
  }
  return undefined;
}

function pointsMatchingFilter(filter: unknown): StoredPoint[] {
  const tt = mustValue(filter, "target_type");
  const plugin = mustValue(filter, "plugin");
  return [...store.values()].filter(
    (p) =>
      (tt === undefined || p.target_type === tt) &&
      (plugin === undefined || p.plugin === plugin),
  );
}

const fakeQdrant = {
  async upsert(
    targetType: string,
    targetId: string,
    _vector: number[],
    payload: Record<string, unknown>,
    sparse?: SparseEmbedding,
  ) {
    calls.upserts.push({ targetType, targetId, payload, sparse });
    store.set(targetId, {
      target_type: targetType,
      target_id: targetId,
      ...payload,
    });
    return targetId;
  },
  async hybridSearch(params: { filter?: unknown }) {
    calls.hybrid.push({ filter: params.filter });
    return pointsMatchingFilter(params.filter).map((p) => ({
      id: p.target_id,
      score: 0.9,
      payload: p,
    }));
  },
  async search(_vector: number[], limit: number, filter: unknown) {
    calls.search.push({ limit, filter });
    return pointsMatchingFilter(filter).map((p) => ({
      id: p.target_id,
      score: 0.5,
      payload: p,
    }));
  },
  async getByTarget(
    targetType: string,
    targetId: string,
    opts?: { plugin?: string },
  ) {
    calls.get.push({ targetId, plugin: opts?.plugin });
    const p = store.get(targetId);
    if (!p || p.target_type !== targetType) {
      return null;
    }
    if (opts?.plugin !== undefined && p.plugin !== opts.plugin) {
      return null;
    }
    return { id: targetId, payload: p };
  },
  async deleteByTargetAndPlugin(
    targetType: string,
    targetId: string,
    plugin: string,
  ) {
    calls.deleteScoped.push({ targetId, plugin });
    const p = store.get(targetId);
    if (p && p.target_type === targetType && p.plugin === plugin) {
      store.delete(targetId);
    }
  },
  async deleteByPlugin(plugin: string) {
    calls.deletePlugin.push(plugin);
    for (const [k, p] of [...store.entries()]) {
      if (p.plugin === plugin) {
        store.delete(k);
      }
    }
  },
};

// The client is already initialized in this process, so the ops resolve it
// straight from the singleton. `plugin-index-qdrant-init.test.ts` covers the
// other side: a process where it is not.
mock.module("../qdrant-client.js", () => ({
  getQdrantClient: () => fakeQdrant,
  initQdrantClient: () => fakeQdrant,
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));
mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({
    memory: {
      qdrant: {
        collection: "vellum_memory",
        vectorSize: 3,
        onDisk: true,
        quantization: "none",
      },
      embeddings: { provider: "gemini" },
    },
  }),
}));
mock.module("../qdrant-circuit-breaker.js", () => ({
  withQdrantBreaker: <T>(fn: () => Promise<T>) => fn(),
}));
mock.module("../embed.js", () => ({
  embedWithRetry: async () => ({
    provider: "gemini",
    model: "test-embed-model",
    vectors: [[0.1, 0.2, 0.3]],
  }),
}));
mock.module("../embedding-backend.js", () => ({
  selectEmbeddingBackend: async () => ({
    backend: { provider: "gemini", model: "test-embed-model" },
    reason: null,
  }),
  getMemoryBackendStatus: async () => ({
    enabled: true,
    degraded: false,
    provider: "gemini",
    model: "test-embed-model",
    reason: null,
  }),
  // Mirror the real encoder: text with word chars yields a non-empty sparse
  // vector; a whitespace/punctuation-only string yields an empty one (which
  // drives the dense-only query fallback).
  generateSparseEmbedding: (text: string): SparseEmbedding =>
    /[\p{L}\p{N}]/u.test(text)
      ? { indices: [1, 2], values: [0.5, 0.5] }
      : { indices: [], values: [] },
}));

const {
  computeEmbedding,
  computeSparseEmbedding,
  indexDocument,
  queryIndex,
  getDocument,
  removeDocument,
  purgeEmbeddingsForPlugin,
} = await import("../plugin-index.js");

// A stand-in config; every host boundary that reads it is mocked above.
const CONFIG = {} as never;

beforeEach(() => {
  store.clear();
  calls.upserts.length = 0;
  calls.hybrid.length = 0;
  calls.search.length = 0;
  calls.get.length = 0;
  calls.deleteScoped.length = 0;
  calls.deletePlugin.length = 0;
});

afterAll(() => {
  mock.restore();
});

describe("compute-only", () => {
  test("computeEmbedding returns the dense vector with provenance", async () => {
    const result = await computeEmbedding(CONFIG, "hello world");
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("test-embed-model");
    expect(result.dimensions).toBe(3);
    // Compute-only: nothing is persisted.
    expect(calls.upserts).toHaveLength(0);
  });

  test("computeSparseEmbedding is pure, no upsert", () => {
    const sparse = computeSparseEmbedding("budget call notes");
    expect(sparse.indices.length).toBeGreaterThan(0);
    expect(calls.upserts).toHaveLength(0);
  });
});

describe("plugin-owned index", () => {
  test("indexDocument tags the plugin, namespace-qualifies the point, returns a bare id", async () => {
    const res = await indexDocument(
      CONFIG,
      "ledger",
      "budget call with Alice",
      {
        metadata: { rowId: "row-42" },
      },
    );
    expect(res.documentId).toBeTruthy();
    expect(calls.upserts).toHaveLength(1);
    const up = calls.upserts[0];
    expect(up.targetType).toBe("plugin_index");
    // Point id is namespace-qualified; the bare id round-trips via document_id.
    expect(up.targetId).toBe(`ledger:${res.documentId}`);
    expect(up.payload.plugin).toBe("ledger");
    expect(up.payload.document_id).toBe(res.documentId);
    expect(up.payload.meta).toEqual({ rowId: "row-42" });
    expect(up.payload.text).toBe("budget call with Alice");
    // Text input carries a sparse vector for hybrid search.
    expect(up.sparse?.indices.length).toBeGreaterThan(0);
  });

  test("indexDocument reuses a caller-supplied documentId (update path)", async () => {
    const first = await indexDocument(CONFIG, "ledger", "v1", {
      documentId: "fixed-id",
    });
    const second = await indexDocument(CONFIG, "ledger", "v2", {
      documentId: "fixed-id",
    });
    expect(first.documentId).toBe("fixed-id");
    expect(second.documentId).toBe("fixed-id");
    expect(calls.upserts.map((u) => u.targetId)).toEqual([
      "ledger:fixed-id",
      "ledger:fixed-id",
    ]);
  });

  test("two plugins can share a documentId without colliding", async () => {
    await indexDocument(CONFIG, "ledger", "ledger note", {
      documentId: "shared",
    });
    await indexDocument(CONFIG, "drive", "drive note", {
      documentId: "shared",
    });
    // Distinct namespace-qualified points, not one overwritten point.
    expect(store.size).toBe(2);
    const ledgerDoc = await getDocument("ledger", "shared");
    const driveDoc = await getDocument("drive", "shared");
    expect(ledgerDoc?.text).toBe("ledger note");
    expect(driveDoc?.text).toBe("drive note");
  });

  test("queryIndex hybrid-searches scoped to the calling plugin", async () => {
    await indexDocument(CONFIG, "ledger", "budget call", {
      metadata: { rowId: "row-1" },
    });
    const hits = await queryIndex(CONFIG, "ledger", "budget");
    expect(calls.hybrid).toHaveLength(1);
    const filter = calls.hybrid[0].filter as {
      must: Array<Record<string, { value: string }>>;
    };
    expect(filter.must).toEqual(
      expect.arrayContaining([
        { key: "target_type", match: { value: "plugin_index" } },
        { key: "plugin", match: { value: "ledger" } },
      ]),
    );
    expect(hits[0]).toMatchObject({
      documentId: expect.any(String),
      text: "budget call",
      metadata: { rowId: "row-1" },
    });
  });

  test("queryIndex only returns the calling plugin's documents", async () => {
    await indexDocument(CONFIG, "ledger", "budget call", { documentId: "a" });
    await indexDocument(CONFIG, "drive", "budget report", { documentId: "b" });
    const hits = await queryIndex(CONFIG, "ledger", "budget");
    expect(hits.map((h) => h.documentId)).toEqual(["a"]);
  });

  test("queryIndex falls back to dense-only when the query has no tokens", async () => {
    await indexDocument(CONFIG, "ledger", "budget call");
    await queryIndex(CONFIG, "ledger", "   ");
    expect(calls.hybrid).toHaveLength(0);
    expect(calls.search).toHaveLength(1);
  });

  test("getDocument is scoped: one plugin cannot read another's document", async () => {
    const { documentId } = await indexDocument(CONFIG, "ledger", "secret note");
    // Owner can read it back.
    const own = await getDocument("ledger", documentId);
    expect(own?.text).toBe("secret note");
    // A different plugin guessing the id gets nothing (plugin-scoped filter).
    const other = await getDocument("evil", documentId);
    expect(other).toBeNull();
    expect(calls.get.at(-1)).toEqual({
      targetId: `evil:${documentId}`,
      plugin: "evil",
    });
  });

  test("removeDocument deletes scoped to the calling plugin", async () => {
    const { documentId } = await indexDocument(CONFIG, "ledger", "note");
    await removeDocument("ledger", documentId);
    expect(calls.deleteScoped).toEqual([
      { targetId: `ledger:${documentId}`, plugin: "ledger" },
    ]);
    expect(await getDocument("ledger", documentId)).toBeNull();
  });

  test("purgeEmbeddingsForPlugin drops the whole plugin namespace", async () => {
    await indexDocument(CONFIG, "ledger", "a");
    await indexDocument(CONFIG, "ledger", "b");
    await indexDocument(CONFIG, "other", "c");
    await purgeEmbeddingsForPlugin("ledger");
    expect(calls.deletePlugin).toEqual(["ledger"]);
    // The other plugin's document survives.
    expect([...store.values()].map((p) => p.plugin)).toEqual(["other"]);
  });
});
