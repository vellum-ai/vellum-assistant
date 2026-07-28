import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SparseEmbedding } from "../embedding-types.js";

// ---------------------------------------------------------------------------
// Boundary mocks. This file runs in its own Bun process (see scripts/test.ts),
// so mock.module here cannot leak into other test files.
// ---------------------------------------------------------------------------

interface UpsertCall {
  targetType: string;
  targetId: string;
  vector: number[];
  payload: Record<string, unknown>;
  sparse?: SparseEmbedding;
}
interface StoredPoint {
  target_type: string;
  target_id: string;
  [k: string]: unknown;
}

const calls = {
  upserts: [] as UpsertCall[],
  hybrid: [] as Array<Record<string, unknown>>,
  search: [] as Array<{ limit: number; filter: unknown }>,
  get: [] as Array<{ targetId: string; plugin?: string }>,
  deleteScoped: [] as Array<{ targetId: string; plugin: string }>,
  deletePlugin: [] as string[],
};
const store = new Map<string, StoredPoint>();
const key = (plugin: unknown, id: string) => `${String(plugin)}:${id}`;

const fakeQdrant = {
  async upsert(
    targetType: string,
    targetId: string,
    vector: number[],
    payload: Record<string, unknown>,
    sparse?: SparseEmbedding,
  ) {
    calls.upserts.push({ targetType, targetId, vector, payload, sparse });
    store.set(key(payload.plugin, targetId), {
      target_type: targetType,
      target_id: targetId,
      ...payload,
    });
    return targetId;
  },
  async hybridSearch(params: { plugin?: string; filter?: unknown }) {
    calls.hybrid.push(params as Record<string, unknown>);
    return [...store.values()].map((p) => ({
      id: p.target_id,
      score: 0.9,
      payload: p,
    }));
  },
  async search(_vector: number[], limit: number, filter: unknown) {
    calls.search.push({ limit, filter });
    return [...store.values()].map((p) => ({
      id: p.target_id,
      score: 0.5,
      payload: p,
    }));
  },
  async getByTarget(
    _targetType: string,
    targetId: string,
    opts?: { plugin?: string },
  ) {
    calls.get.push({ targetId, plugin: opts?.plugin });
    const p = store.get(key(opts?.plugin, targetId));
    return p ? { id: targetId, payload: p } : null;
  },
  async deleteByTargetAndPlugin(_t: string, targetId: string, plugin: string) {
    calls.deleteScoped.push({ targetId, plugin });
    store.delete(key(plugin, targetId));
  },
  async deleteByPlugin(plugin: string) {
    calls.deletePlugin.push(plugin);
    for (const k of [...store.keys()]) {
      if (k.startsWith(`${plugin}:`)) {
        store.delete(k);
      }
    }
  },
};

mock.module("../qdrant-client.js", () => ({
  getQdrantClient: () => fakeQdrant,
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
  getMemoryBackendStatus: async () => ({
    enabled: true,
    degraded: false,
    provider: "gemini",
    model: "test-embed-model",
    reason: null,
  }),
  // Mirror the real encoder: text with word chars → non-empty sparse; a
  // whitespace/punctuation-only string → empty sparse (drives the dense-only
  // query fallback).
  generateSparseEmbedding: (text: string): SparseEmbedding =>
    /[\p{L}\p{N}]/u.test(text)
      ? { indices: [1, 2], values: [0.5, 0.5] }
      : { indices: [], values: [] },
}));

const {
  computePluginEmbedding,
  computePluginSparseEmbedding,
  indexPluginDocument,
  queryPluginIndex,
  getPluginDocument,
  removePluginDocument,
  purgePluginEmbeddings,
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

describe("Layer 1 — compute only", () => {
  test("computePluginEmbedding returns the dense vector with provenance", async () => {
    const result = await computePluginEmbedding(CONFIG, "hello world");
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("test-embed-model");
    expect(result.dimensions).toBe(3);
    // Compute-only: nothing is persisted.
    expect(calls.upserts).toHaveLength(0);
  });

  test("computePluginSparseEmbedding is pure — no upsert", () => {
    const sparse = computePluginSparseEmbedding("budget call notes");
    expect(sparse.indices.length).toBeGreaterThan(0);
    expect(calls.upserts).toHaveLength(0);
  });
});

describe("Layer 2 — plugin index", () => {
  test("indexPluginDocument tags the plugin + plugin_index type and returns an id", async () => {
    const res = await indexPluginDocument(
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
    expect(up.targetId).toBe(res.documentId);
    expect(up.payload.plugin).toBe("ledger");
    expect(up.payload.meta).toEqual({ rowId: "row-42" });
    expect(up.payload.text).toBe("budget call with Alice");
    // Text input carries a sparse vector for hybrid search.
    expect(up.sparse?.indices.length).toBeGreaterThan(0);
  });

  test("indexPluginDocument reuses a caller-supplied documentId (update path)", async () => {
    const first = await indexPluginDocument(CONFIG, "ledger", "v1", {
      documentId: "fixed-id",
    });
    const second = await indexPluginDocument(CONFIG, "ledger", "v2", {
      documentId: "fixed-id",
    });
    expect(first.documentId).toBe("fixed-id");
    expect(second.documentId).toBe("fixed-id");
    expect(calls.upserts.map((u) => u.targetId)).toEqual([
      "fixed-id",
      "fixed-id",
    ]);
  });

  test("queryPluginIndex hybrid-searches scoped to the calling plugin", async () => {
    await indexPluginDocument(CONFIG, "ledger", "budget call", {
      metadata: { rowId: "row-1" },
    });
    const hits = await queryPluginIndex(CONFIG, "ledger", "budget");
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

  test("queryPluginIndex falls back to dense-only when the query has no tokens", async () => {
    await indexPluginDocument(CONFIG, "ledger", "budget call");
    await queryPluginIndex(CONFIG, "ledger", "   ");
    expect(calls.hybrid).toHaveLength(0);
    expect(calls.search).toHaveLength(1);
  });

  test("getPluginDocument is scoped — one plugin cannot read another's document", async () => {
    const { documentId } = await indexPluginDocument(
      CONFIG,
      "ledger",
      "secret note",
    );
    // Owner can read it back.
    const own = await getPluginDocument("ledger", documentId);
    expect(own?.text).toBe("secret note");
    // A different plugin guessing the id gets nothing (plugin-scoped filter).
    const other = await getPluginDocument("evil", documentId);
    expect(other).toBeNull();
    expect(calls.get.at(-1)).toEqual({ targetId: documentId, plugin: "evil" });
  });

  test("removePluginDocument deletes scoped to the calling plugin", async () => {
    const { documentId } = await indexPluginDocument(CONFIG, "ledger", "note");
    await removePluginDocument("ledger", documentId);
    expect(calls.deleteScoped).toEqual([
      { targetId: documentId, plugin: "ledger" },
    ]);
    expect(await getPluginDocument("ledger", documentId)).toBeNull();
  });

  test("purgePluginEmbeddings drops the whole plugin namespace", async () => {
    await indexPluginDocument(CONFIG, "ledger", "a");
    await indexPluginDocument(CONFIG, "ledger", "b");
    await indexPluginDocument(CONFIG, "other", "c");
    await purgePluginEmbeddings("ledger");
    expect(calls.deletePlugin).toEqual(["ledger"]);
    // The other plugin's document survives.
    expect([...store.values()].map((p) => p.plugin)).toEqual(["other"]);
  });
});
