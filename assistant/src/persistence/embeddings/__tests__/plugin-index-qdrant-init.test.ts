import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SparseEmbedding } from "../embedding-types.js";

// ---------------------------------------------------------------------------
// Regression: the plugin index must not depend on the memory tier — or on the
// daemon — having initialized the shared Qdrant client.
//
// `runMemoryStartup` calls `initQdrantClient` only in the daemon process, and
// only while memory v1 is the live tier; on a default workspace
// (`memory.v2.enabled` defaults true, or `memory.v3.live`) it is skipped, so
// `getQdrantClient()` throws and every plugin Index op used to fail with
// `BackendUnavailableError: Qdrant client not initialized`. The ops must
// initialize the client themselves from the live workspace config, and rebuild
// it when that config changes rather than serving a stale one.
//
// The fake singleton below behaves like the real one — absent until
// `initQdrantClient` sets it — where `plugin-index.test.ts` mocks a client that
// is already up. Each test file runs in its own Bun process (see
// scripts/test.ts), so the two mocks cannot collide.
// ---------------------------------------------------------------------------

interface InitCall {
  url: string;
  collection: string;
  vectorSize: number;
  onDisk: boolean;
  quantization: string;
  embeddingModel?: string;
}

const calls = {
  init: [] as InitCall[],
  upserts: [] as Array<{ targetType: string; targetId: string }>,
  get: [] as Array<{ targetId: string }>,
  deleteScoped: [] as Array<{ targetId: string }>,
};

const fakeQdrant = {
  async upsert(targetType: string, targetId: string) {
    calls.upserts.push({ targetType, targetId });
  },
  async getByTarget(_targetType: string, targetId: string) {
    calls.get.push({ targetId });
    return null;
  },
  async deleteByTargetAndPlugin(_targetType: string, targetId: string) {
    calls.deleteScoped.push({ targetId });
  },
  async hybridSearch() {
    return [];
  },
  async search() {
    return [];
  },
};

/** Stands in for the module singleton in `qdrant-client.ts`: null until set. */
let instance: typeof fakeQdrant | null = null;

mock.module("../qdrant-client.js", () => ({
  getQdrantClient: () => {
    if (!instance) {
      throw new Error("Qdrant client not initialized. Call initQdrantClient()");
    }
    return instance;
  },
  initQdrantClient: (cfg: InitCall) => {
    calls.init.push(cfg);
    instance = fakeQdrant;
    return instance;
  },
  resolveQdrantUrl: () => "http://127.0.0.1:7777",
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
    backend: { provider: "gemini", model: liveConfig.memory.embeddings.model },
    reason: null,
  }),
  getMemoryBackendStatus: async () => ({
    enabled: true,
    degraded: false,
    provider: "gemini",
    model: liveConfig.memory.embeddings.model,
    reason: null,
  }),
  generateSparseEmbedding: (): SparseEmbedding => ({
    indices: [1, 2],
    values: [0.5, 0.5],
  }),
}));

/** The workspace config `getConfig()` returns; mutated to simulate a reload. */
let liveConfig = {
  memory: {
    qdrant: {
      collection: "vellum_memory",
      vectorSize: 768,
      onDisk: true,
      quantization: "scalar",
    },
    embeddings: { provider: "gemini", model: "test-embed-model" },
  },
};

mock.module("../../../config/loader.js", () => ({
  getConfig: () => liveConfig,
}));

const { indexDocument, queryIndex, getDocument, removeDocument } =
  await import("../plugin-index.js");

beforeEach(() => {
  calls.init.length = 0;
  calls.upserts.length = 0;
  calls.get.length = 0;
  calls.deleteScoped.length = 0;
});

afterAll(() => {
  mock.restore();
});

describe("plugin index without a pre-initialized Qdrant client", () => {
  test("indexDocument initializes the client from config instead of throwing", async () => {
    const res = await indexDocument(
      liveConfig as never,
      "ledger",
      "Morning coffee",
    );

    expect(res.documentId).toBeTruthy();
    expect(calls.upserts).toEqual([
      { targetType: "plugin_index", targetId: `ledger:${res.documentId}` },
    ]);
    // Same shared collection, same dimension, and the dense model identity so
    // the collection keeps its create/migrate semantics.
    expect(calls.init).toEqual([
      {
        url: "http://127.0.0.1:7777",
        collection: "vellum_memory",
        vectorSize: 768,
        onDisk: true,
        quantization: "scalar",
        embeddingModel: "gemini:test-embed-model",
      },
    ]);
  });

  test("query/get/remove also work without a pre-initialized client", async () => {
    await expect(
      queryIndex(liveConfig as never, "ledger", "coffee"),
    ).resolves.toEqual([]);
    await expect(getDocument("ledger", "doc-1")).resolves.toBeNull();
    await expect(removeDocument("ledger", "doc-1")).resolves.toBeUndefined();

    expect(calls.get).toEqual([{ targetId: "ledger:doc-1" }]);
    expect(calls.deleteScoped).toEqual([{ targetId: "ledger:doc-1" }]);
  });

  test("an unchanged config reuses the client instead of rebuilding it", async () => {
    await indexDocument(liveConfig as never, "ledger", "one");
    await indexDocument(liveConfig as never, "ledger", "two");
    await getDocument("ledger", "doc-1");

    expect(calls.upserts).toHaveLength(2);
    expect(calls.init).toHaveLength(0); // already built by an earlier test
  });

  test("a live embedding-config change rebuilds the client", async () => {
    await indexDocument(liveConfig as never, "ledger", "before");
    expect(calls.init).toHaveLength(0);

    // A model swap at the same dimension: the client's captured model identity
    // is now wrong, so reusing it would mix two models' vectors in one
    // collection without tripping the sentinel migration.
    liveConfig = {
      memory: {
        ...liveConfig.memory,
        embeddings: { provider: "gemini", model: "swapped-embed-model" },
      },
    };
    await indexDocument(liveConfig as never, "ledger", "after");

    expect(calls.init).toEqual([
      {
        url: "http://127.0.0.1:7777",
        collection: "vellum_memory",
        vectorSize: 768,
        onDisk: true,
        quantization: "scalar",
        embeddingModel: "gemini:swapped-embed-model",
      },
    ]);
  });

  test("a dimension change rebuilds the client", async () => {
    liveConfig = {
      memory: {
        ...liveConfig.memory,
        qdrant: { ...liveConfig.memory.qdrant, vectorSize: 1536 },
      },
    };
    await indexDocument(liveConfig as never, "ledger", "resized");

    expect(calls.init).toHaveLength(1);
    expect(calls.init[0].vectorSize).toBe(1536);
  });
});
