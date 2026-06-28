/**
 * Verifies the embeddings + vector-store host facets:
 *
 * 1. A plugin can embed text via `host.embeddings.embed(...)`, which delegates
 *    to the configured embedding backend — the plugin never sees the backend.
 * 2. A plugin can upsert/search/delete vectors in its OWN namespaced
 *    collection via `host.vectorStore.collection(...)`, and two plugins asking
 *    for the same logical name get distinct, collision-free collections.
 *
 * The persistence layer is stubbed with `mock.module` so the test exercises
 * the facet wiring (and the host-side namespacing) without a live Qdrant or
 * embedding backend — and the plugin code under test imports only the facet,
 * never `persistence/`.
 */

import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module-level stubs — installed before importing the modules under test
// ---------------------------------------------------------------------------

mock.module("../../util/logger.js", () => ({
  getLogger: () => ({
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }),
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({}),
  getNestedValue: () => undefined,
}));

const embedWithBackendSpy = mock(async (_config: unknown, texts: string[]) => ({
  provider: "local",
  model: "stub-model",
  // Deterministic 2-dim vector per input so assertions are stable.
  vectors: texts.map((_t, i) => [i, i + 1]),
}));
mock.module("../../persistence/embeddings/embedding-backend.js", () => ({
  embedWithBackend: embedWithBackendSpy,
}));

/**
 * In-memory fake of one Qdrant collection. Keyed by collection name so the
 * namespacing assertion can inspect which collection a plugin actually wrote.
 */
const collections = new Map<
  string,
  Map<string, { vector: number[]; payload: Record<string, unknown> }>
>();

function fakeCollection(name: string) {
  let store = collections.get(name);
  if (!store) {
    store = new Map();
    collections.set(name, store);
  }
  return {
    upsert: mock(
      async (
        points: Array<{
          id: string;
          vector: number[];
          payload?: Record<string, unknown>;
        }>,
      ) => {
        for (const p of points) {
          store!.set(p.id, { vector: p.vector, payload: p.payload ?? {} });
        }
      },
    ),
    search: mock(async (_vector: number[], limit: number) =>
      [...store!.entries()].slice(0, limit).map(([id, v], idx) => ({
        id,
        score: 1 - idx * 0.1,
        payload: v.payload,
      })),
    ),
    delete: mock(async (ids: string[]) => {
      for (const id of ids) store!.delete(id);
    }),
  };
}

const openSpy = mock((hostId: string, name: string, _vectorSize: number) =>
  fakeCollection(`plugin_${hostId}_${name}`),
);
mock.module("../../persistence/embeddings/plugin-vector-store.js", () => ({
  openPluginVectorCollection: openSpy,
}));

// ---------------------------------------------------------------------------
// Modules under test — imported after every stub is in place
// ---------------------------------------------------------------------------

import {
  buildEmbeddingsFacet,
  buildVectorStoreFacet,
} from "../skill-host-facets.js";

describe("embeddings + vector-store host facets", () => {
  test("a plugin embeds text via the facet without touching persistence", async () => {
    const embeddings = buildEmbeddingsFacet();
    const vectors = await embeddings.embed(["alpha", "beta"]);

    expect(vectors).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(embedWithBackendSpy).toHaveBeenCalled();
  });

  test("a plugin upserts and searches vectors in its own namespaced collection", async () => {
    const vectorStore = buildVectorStoreFacet("plugin-a");
    const col = await vectorStore.collection("pages", { vectorSize: 2 });

    await col.upsert([
      { id: "p1", vector: [0.1, 0.2], payload: { kind: "page" } },
      { id: "p2", vector: [0.3, 0.4], payload: { kind: "page" } },
    ]);

    const hits = await col.search([0.1, 0.2], 5);
    expect(hits.map((h) => h.id).sort()).toEqual(["p1", "p2"]);
    expect(hits[0].payload).toEqual({ kind: "page" });

    // The host namespaced the collection by the plugin id.
    expect(openSpy).toHaveBeenCalledWith("plugin-a", "pages", 2);
    expect(collections.has("plugin_plugin-a_pages")).toBe(true);

    await col.delete(["p1"]);
    const afterDelete = await col.search([0.1, 0.2], 5);
    expect(afterDelete.map((h) => h.id)).toEqual(["p2"]);
  });

  test("two plugins using the same collection name do not collide", async () => {
    const colA = await buildVectorStoreFacet("plugin-a").collection("notes", {
      vectorSize: 2,
    });
    const colB = await buildVectorStoreFacet("plugin-b").collection("notes", {
      vectorSize: 2,
    });

    await colA.upsert([{ id: "x", vector: [1, 0], payload: { owner: "a" } }]);
    await colB.upsert([{ id: "x", vector: [0, 1], payload: { owner: "b" } }]);

    const fromA = await colA.search([1, 0], 5);
    const fromB = await colB.search([0, 1], 5);

    expect(fromA).toHaveLength(1);
    expect(fromA[0].payload).toEqual({ owner: "a" });
    expect(fromB[0].payload).toEqual({ owner: "b" });
    expect(collections.has("plugin_plugin-a_notes")).toBe(true);
    expect(collections.has("plugin_plugin-b_notes")).toBe(true);
  });
});
