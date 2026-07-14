import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock Qdrant REST client ───────────────────────────────────────────

interface CreateCollectionCall {
  name: string;
  config: Record<string, unknown>;
}

interface UpsertCall {
  name: string;
  opts: { points: Array<Record<string, unknown>> };
}

interface QueryCall {
  name: string;
  opts: Record<string, unknown>;
}

interface DeleteCall {
  name: string;
  opts: { filter?: Record<string, unknown>; points?: Array<string | number> };
}

let mockCollectionExists: boolean;
let createCollectionCalls: CreateCollectionCall[];
let upsertCalls: UpsertCall[];
let queryCalls: QueryCall[];
let deleteCalls: DeleteCall[];
let deleteCollectionCalls: string[];
let payloadIndexCalls: Array<Record<string, unknown>>;
// Sparse-vector config reported by getCollection for an existing collection.
let mockSparseVectors: Record<string, unknown> | null;
// Optimizer config reported by getCollection for an existing collection.
let mockOptimizerConfig: Record<string, unknown> | null;
let updateCollectionCalls: Array<{ name: string; params: unknown }>;
let mockUpdateCollectionError: Error | null;
let mockQueryPoints: Array<{
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
}>;

function resetMockState() {
  mockCollectionExists = false;
  createCollectionCalls = [];
  upsertCalls = [];
  queryCalls = [];
  deleteCalls = [];
  deleteCollectionCalls = [];
  payloadIndexCalls = [];
  mockSparseVectors = { sparse: { index: { on_disk: true } } };
  mockOptimizerConfig = { default_segment_number: 2 };
  updateCollectionCalls = [];
  mockUpdateCollectionError = null;
  mockQueryPoints = [];
}

mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: class MockQdrantClient {
    async collectionExists(_name: string) {
      return { exists: mockCollectionExists };
    }

    async createCollection(name: string, config: Record<string, unknown>) {
      createCollectionCalls.push({ name, config });
      mockCollectionExists = true;
    }

    async getCollection(_name: string) {
      return {
        config: {
          params: {
            ...(mockSparseVectors ? { sparse_vectors: mockSparseVectors } : {}),
          },
          ...(mockOptimizerConfig
            ? { optimizer_config: mockOptimizerConfig }
            : {}),
        },
      };
    }

    async updateCollection(name: string, params: unknown) {
      if (mockUpdateCollectionError) {
        throw mockUpdateCollectionError;
      }
      updateCollectionCalls.push({ name, params });
    }

    async createPayloadIndex(_name: string, config: Record<string, unknown>) {
      payloadIndexCalls.push(config);
    }

    async upsert(
      name: string,
      opts: { points: Array<Record<string, unknown>> },
    ) {
      upsertCalls.push({ name, opts });
    }

    async query(name: string, opts: Record<string, unknown>) {
      queryCalls.push({ name, opts });
      return { points: mockQueryPoints };
    }

    async delete(name: string, opts: DeleteCall["opts"]) {
      deleteCalls.push({ name, opts });
    }

    async deleteCollection(name: string) {
      deleteCollectionCalls.push(name);
      mockCollectionExists = false;
    }

    async count(_name: string, _opts: unknown) {
      return { count: 7 };
    }
  },
}));

import type { SparseEmbedding } from "../embedding-types.js";
import {
  messagePointId,
  MessagesLexicalIndex,
} from "../messages-lexical-index.js";

const SPARSE: SparseEmbedding = { indices: [1, 5, 9], values: [0.5, 0.2, 0.8] };

function makeIndex() {
  return new MessagesLexicalIndex({ url: "http://localhost:6333" });
}

beforeEach(() => {
  resetMockState();
});

describe("MessagesLexicalIndex", () => {
  test("creates a sparse-only collection (no dense vectors config)", async () => {
    const index = makeIndex();
    await index.ensureCollection();

    expect(createCollectionCalls.length).toBe(1);
    const config = createCollectionCalls[0].config;

    // Sparse vector named "sparse" must be present, with its inverted index
    // on disk instead of Qdrant's in-RAM default — this index grows with
    // every message ever written.
    expect(config.sparse_vectors).toBeDefined();
    expect((config.sparse_vectors as Record<string, unknown>).sparse).toEqual({
      index: { on_disk: true },
    });

    // No dense `vectors` config at all.
    expect(config.vectors).toBeUndefined();
    expect("vectors" in config).toBe(false);

    // Explicit segment count — never Qdrant's CPU-count auto-detection.
    expect(config.optimizers_config).toEqual({ default_segment_number: 2 });

    // Payload indexes on conversation_id (keyword) + created_at (integer).
    const fields = payloadIndexCalls.map((c) => c.field_name);
    expect(fields).toContain("conversation_id");
    expect(fields).toContain("created_at");
    const convIdx = payloadIndexCalls.find(
      (c) => c.field_name === "conversation_id",
    );
    const createdIdx = payloadIndexCalls.find(
      (c) => c.field_name === "created_at",
    );
    expect(convIdx?.field_schema).toBe("keyword");
    expect(createdIdx?.field_schema).toBe("integer");
  });

  test("moves an in-RAM sparse index to disk on an existing collection", async () => {
    mockCollectionExists = true;
    // Collection created before the sparse index carried an explicit placement.
    mockSparseVectors = { sparse: {} };

    const index = makeIndex();
    await index.ensureCollection();

    // In-place update only — the collection is never dropped or recreated.
    expect(createCollectionCalls).toEqual([]);
    expect(deleteCollectionCalls).toEqual([]);
    expect(updateCollectionCalls).toEqual([
      {
        name: "messages_lexical",
        params: { sparse_vectors: { sparse: { index: { on_disk: true } } } },
      },
    ]);
  });

  test("leaves an already on-disk sparse index alone", async () => {
    mockCollectionExists = true;
    mockSparseVectors = { sparse: { index: { on_disk: true } } };

    const index = makeIndex();
    await index.ensureCollection();

    expect(updateCollectionCalls).toEqual([]);
  });

  test("sets the explicit segment count on an existing auto-sized collection", async () => {
    mockCollectionExists = true;
    // Collection created before the explicit count: Qdrant auto-detected 8
    // segments from the node's CPU count.
    mockOptimizerConfig = { default_segment_number: 8 };

    const index = makeIndex();
    await index.ensureCollection();

    expect(createCollectionCalls).toEqual([]);
    expect(deleteCollectionCalls).toEqual([]);
    expect(updateCollectionCalls).toEqual([
      {
        name: "messages_lexical",
        params: { optimizers_config: { default_segment_number: 2 } },
      },
    ]);
  });

  test("treats an unset segment count (auto) as needing the explicit value", async () => {
    mockCollectionExists = true;
    mockOptimizerConfig = { default_segment_number: null };

    const index = makeIndex();
    await index.ensureCollection();

    expect(updateCollectionCalls).toEqual([
      {
        name: "messages_lexical",
        params: { optimizers_config: { default_segment_number: 2 } },
      },
    ]);
  });

  test("leaves a collection already at the target segment count alone", async () => {
    mockCollectionExists = true;
    mockOptimizerConfig = { default_segment_number: 2 };

    const index = makeIndex();
    await index.ensureCollection();

    expect(updateCollectionCalls).toEqual([]);
  });

  test("a failed segment-count update is swallowed and startup continues", async () => {
    mockCollectionExists = true;
    mockOptimizerConfig = { default_segment_number: 8 };
    mockUpdateCollectionError = new Error("qdrant unavailable");

    const index = makeIndex();
    await index.ensureCollection();

    // No update recorded (it threw) — but ensureCollection completed and the
    // payload indexes were still ensured.
    expect(updateCollectionCalls).toEqual([]);
    expect(payloadIndexCalls.length).toBeGreaterThan(0);

    // The collection is usable: a subsequent write goes straight through.
    await index.upsertMessage("m1", SPARSE, {
      conversationId: "c1",
      createdAt: 1,
    });
    expect(upsertCalls.length).toBe(1);
  });

  test("upsertMessage writes a deterministic point id and a sparse-only vector with the right payload", async () => {
    const index = makeIndex();
    await index.upsertMessage("msg-123", SPARSE, {
      conversationId: "conv-abc",
      createdAt: 1700000000,
    });

    expect(upsertCalls.length).toBe(1);
    const points = upsertCalls[0].opts.points;
    expect(points.length).toBe(1);
    const point = points[0] as {
      id: string;
      vector: Record<string, unknown>;
      payload: Record<string, unknown>;
    };

    // Deterministic point id derived from message id.
    expect(point.id).toBe(messagePointId("msg-123"));

    // Sparse-only vector under the "sparse" named vector, no dense vector.
    expect(point.vector.sparse).toEqual({
      indices: SPARSE.indices,
      values: SPARSE.values,
    });
    expect(point.vector.dense).toBeUndefined();
    expect("dense" in point.vector).toBe(false);
    // The vector field carries only the sparse named vector.
    expect(Object.keys(point.vector)).toEqual(["sparse"]);

    // Payload carries message_id, conversation_id, created_at.
    expect(point.payload.message_id).toBe("msg-123");
    expect(point.payload.conversation_id).toBe("conv-abc");
    expect(point.payload.created_at).toBe(1700000000);
  });

  test("re-upserting the same messageId yields the same point id (idempotent)", async () => {
    const index = makeIndex();
    await index.upsertMessage("msg-same", SPARSE, {
      conversationId: "conv-1",
      createdAt: 1,
    });
    await index.upsertMessage("msg-same", SPARSE, {
      conversationId: "conv-1",
      createdAt: 2,
    });

    expect(upsertCalls.length).toBe(2);
    const id1 = (upsertCalls[0].opts.points[0] as { id: string }).id;
    const id2 = (upsertCalls[1].opts.points[0] as { id: string }).id;
    expect(id1).toBe(id2);
    expect(id1).toBe(messagePointId("msg-same"));
    // Distinct message ids map to distinct point ids.
    expect(messagePointId("msg-same")).not.toBe(messagePointId("msg-other"));
  });

  test("upsertMessagesBatch writes many points in a single upsert call", async () => {
    const index = makeIndex();
    await index.upsertMessagesBatch([
      { messageId: "m1", sparse: SPARSE, conversationId: "c1", createdAt: 10 },
      { messageId: "m2", sparse: SPARSE, conversationId: "c2", createdAt: 20 },
    ]);

    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0].opts.points.length).toBe(2);
    const ids = upsertCalls[0].opts.points.map((p) => (p as { id: string }).id);
    expect(ids).toEqual([messagePointId("m1"), messagePointId("m2")]);
  });

  test("searchLexical queries the sparse named vector and returns {messageId, score}", async () => {
    mockQueryPoints = [
      { id: "pt-1", score: 0.91, payload: { message_id: "msg-A" } },
      { id: "pt-2", score: 0.42, payload: { message_id: "msg-B" } },
    ];

    const index = makeIndex();
    const results = await index.searchLexical(SPARSE, 5);

    expect(queryCalls.length).toBe(1);
    const opts = queryCalls[0].opts;
    // Query targets the sparse named vector.
    expect(opts.using).toBe("sparse");
    expect(opts.query).toEqual({
      indices: SPARSE.indices,
      values: SPARSE.values,
    });
    expect(opts.limit).toBe(5);
    // No filter when no conversation scope is given.
    expect(opts.filter).toBeUndefined();

    expect(results).toEqual([
      { messageId: "msg-A", score: 0.91 },
      { messageId: "msg-B", score: 0.42 },
    ]);
  });

  test("searchLexical passes a conversation_id payload filter when given", async () => {
    mockQueryPoints = [
      { id: "pt-1", score: 0.5, payload: { message_id: "msg-A" } },
    ];

    const index = makeIndex();
    await index.searchLexical(SPARSE, 3, { conversationId: "conv-xyz" });

    expect(queryCalls.length).toBe(1);
    const filter = queryCalls[0].opts.filter as {
      must: Array<{ key: string; match: { value: string } }>;
    };
    expect(filter).toBeDefined();
    expect(filter.must).toEqual([
      { key: "conversation_id", match: { value: "conv-xyz" } },
    ]);
  });

  test("deleteByConversation issues a conversation_id payload-filter delete", async () => {
    const index = makeIndex();
    await index.deleteByConversation("conv-del");

    expect(deleteCalls.length).toBe(1);
    const filter = deleteCalls[0].opts.filter as {
      must: Array<{ key: string; match: { value: string } }>;
    };
    expect(filter.must).toEqual([
      { key: "conversation_id", match: { value: "conv-del" } },
    ]);
  });

  test("deleteByMessageId deletes by the deterministic point id (not a payload filter)", async () => {
    const index = makeIndex();
    await index.deleteByMessageId("msg-del");

    expect(deleteCalls.length).toBe(1);
    // `message_id` is unindexed, so deletes target the deterministic point id.
    expect(deleteCalls[0].opts.points).toEqual([messagePointId("msg-del")]);
    expect(deleteCalls[0].opts.filter).toBeUndefined();
  });

  test("count returns the collection count", async () => {
    const index = makeIndex();
    expect(await index.count()).toBe(7);
  });

  test("clear drops the whole collection when it exists", async () => {
    mockCollectionExists = true;
    const index = makeIndex();

    const dropped = await index.clear();

    expect(dropped).toBe(true);
    expect(deleteCollectionCalls).toEqual(["messages_lexical"]);
  });

  test("clear returns false (no throw) when the collection is absent", async () => {
    mockCollectionExists = false;
    const index = makeIndex();

    const dropped = await index.clear();

    expect(dropped).toBe(false);
    expect(deleteCollectionCalls).toEqual([]);
  });

  test("no dense vector is ever written or queried across operations", async () => {
    mockQueryPoints = [
      { id: "pt-1", score: 0.5, payload: { message_id: "msg-A" } },
    ];
    const index = makeIndex();
    await index.upsertMessage("m1", SPARSE, {
      conversationId: "c1",
      createdAt: 1,
    });
    await index.searchLexical(SPARSE, 5);

    // Collection config never declares a dense vector.
    for (const call of createCollectionCalls) {
      expect("vectors" in call.config).toBe(false);
    }
    // No upsert point carries a dense vector.
    for (const call of upsertCalls) {
      for (const point of call.opts.points) {
        const vector = (point as { vector: Record<string, unknown> }).vector;
        expect("dense" in vector).toBe(false);
      }
    }
    // No query targets a dense vector.
    for (const call of queryCalls) {
      expect(call.opts.using).toBe("sparse");
    }
  });
});
