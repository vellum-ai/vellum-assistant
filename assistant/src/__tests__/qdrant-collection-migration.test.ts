import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Mock Qdrant REST client ───────────────────────────────────────────

interface MockCallLog {
  collectionExists: number;
  getCollection: number;
  deleteCollection: number;
  createCollection: number;
  createPayloadIndex: number;
  retrieve: number;
  upsert: number;
}

let mockCollectionExists: boolean;
let mockCollectionSize: number;
let mockUseNamedVectors: boolean;
let mockSentinelPayload: Record<string, unknown> | null;
let callLog: MockCallLog;

function resetMockState() {
  mockCollectionExists = false;
  mockCollectionSize = 384;
  mockUseNamedVectors = false;
  mockSentinelPayload = null;
  callLog = {
    collectionExists: 0,
    getCollection: 0,
    deleteCollection: 0,
    createCollection: 0,
    createPayloadIndex: 0,
    retrieve: 0,
    upsert: 0,
  };
}

mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: class MockQdrantClient {
    async collectionExists(_name: string) {
      callLog.collectionExists++;
      return { exists: mockCollectionExists };
    }

    async getCollection(_name: string) {
      callLog.getCollection++;
      return {
        config: {
          params: {
            vectors: mockUseNamedVectors
              ? { dense: { size: mockCollectionSize } }
              : { size: mockCollectionSize },
          },
        },
      };
    }

    async deleteCollection(_name: string) {
      callLog.deleteCollection++;
      mockCollectionExists = false;
    }

    async createCollection(_name: string, _config: unknown) {
      callLog.createCollection++;
      mockCollectionExists = true;
    }

    async createPayloadIndex(_name: string, _config: unknown) {
      callLog.createPayloadIndex++;
    }

    async retrieve(_name: string, opts: { ids: string[] }) {
      callLog.retrieve++;
      if (
        mockSentinelPayload &&
        opts.ids.includes("00000000-0000-0000-0000-000000000000")
      ) {
        return [{ id: "00000000-0000-0000-0000-000000000000", payload: mockSentinelPayload }];
      }
      return [];
    }

    async upsert(_name: string, _opts: unknown) {
      callLog.upsert++;
    }
  },
}));

import { VellumQdrantClient } from "../memory/qdrant-client.js";

beforeEach(() => {
  resetMockState();
});

describe("Qdrant collection migration", () => {
  test("deletes and recreates collection on dimension mismatch", async () => {
    mockCollectionExists = true;
    mockUseNamedVectors = true;
    mockCollectionSize = 384; // Current collection has 384-dim vectors

    const client = new VellumQdrantClient({
      url: "http://localhost:6333",
      collection: "memory",
      vectorSize: 768, // New config expects 768-dim vectors
      onDisk: false,
      quantization: "none",
      embeddingModel: "gemini:gemini-embedding-2-preview",
    });

    await client.ensureCollection();

    expect(callLog.deleteCollection).toBe(1);
    expect(callLog.createCollection).toBe(1);
  });

  test("deletes and recreates collection on model-only mismatch", async () => {
    mockCollectionExists = true;
    mockUseNamedVectors = true;
    mockCollectionSize = 768; // Same dimension
    mockSentinelPayload = {
      _meta: true,
      embedding_model: "gemini:gemini-embedding-001", // Old model
    };

    const client = new VellumQdrantClient({
      url: "http://localhost:6333",
      collection: "memory",
      vectorSize: 768, // Same dimension
      onDisk: false,
      quantization: "none",
      embeddingModel: "gemini:gemini-embedding-2-preview", // New model
    });

    await client.ensureCollection();

    expect(callLog.deleteCollection).toBe(1);
    expect(callLog.createCollection).toBe(1);
    // Sentinel should be written for the new model
    expect(callLog.upsert).toBe(1);
  });

  test("leaves collection untouched when dimensions and model match", async () => {
    mockCollectionExists = true;
    mockUseNamedVectors = true;
    mockCollectionSize = 768;
    mockSentinelPayload = {
      _meta: true,
      embedding_model: "gemini:gemini-embedding-2-preview",
    };

    const client = new VellumQdrantClient({
      url: "http://localhost:6333",
      collection: "memory",
      vectorSize: 768,
      onDisk: false,
      quantization: "none",
      embeddingModel: "gemini:gemini-embedding-2-preview",
    });

    await client.ensureCollection();

    expect(callLog.deleteCollection).toBe(0);
    expect(callLog.createCollection).toBe(0);
  });

  test("does not rebuild pre-existing collection without sentinel (graceful upgrade)", async () => {
    mockCollectionExists = true;
    mockUseNamedVectors = true;
    mockCollectionSize = 768;
    mockSentinelPayload = null; // No sentinel — pre-existing collection

    const client = new VellumQdrantClient({
      url: "http://localhost:6333",
      collection: "memory",
      vectorSize: 768,
      onDisk: false,
      quantization: "none",
      embeddingModel: "gemini:gemini-embedding-2-preview",
    });

    await client.ensureCollection();

    // No sentinel found → no model mismatch → collection kept
    expect(callLog.deleteCollection).toBe(0);
    expect(callLog.createCollection).toBe(0);
  });

  test("writes sentinel point when creating a new collection", async () => {
    mockCollectionExists = false;

    const client = new VellumQdrantClient({
      url: "http://localhost:6333",
      collection: "memory",
      vectorSize: 768,
      onDisk: false,
      quantization: "none",
      embeddingModel: "gemini:gemini-embedding-2-preview",
    });

    await client.ensureCollection();

    expect(callLog.createCollection).toBe(1);
    // Sentinel upsert should be called
    expect(callLog.upsert).toBe(1);
  });

  test("does not write sentinel when embeddingModel is not provided", async () => {
    mockCollectionExists = false;

    const client = new VellumQdrantClient({
      url: "http://localhost:6333",
      collection: "memory",
      vectorSize: 384,
      onDisk: false,
      quantization: "none",
      // No embeddingModel
    });

    await client.ensureCollection();

    expect(callLog.createCollection).toBe(1);
    // No sentinel should be written
    expect(callLog.upsert).toBe(0);
  });
});
