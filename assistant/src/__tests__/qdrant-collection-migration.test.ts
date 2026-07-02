import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Per-suite tmp data dir so the rebuild sentinel never lands in the
// developer's real ~/.vellum workspace.
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "qdrant-v1-migration-test-"));
const REBUILD_SENTINEL_PATH = join(
  TEST_DATA_DIR,
  ".memory-v1-rebuild-required",
);

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../util/platform.js", () => ({
  getDataDir: () => TEST_DATA_DIR,
  // Bun shares mocked modules across test files; peer tests import
  // `getWorkspaceDir` from this same module, so re-export it here to avoid an
  // `undefined` if this mock is the one that wins evaluation order.
  getWorkspaceDir: () => TEST_DATA_DIR,
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
let mockCreateCollectionThrows: Error | null;
let callLog: MockCallLog;

function resetMockState() {
  mockCollectionExists = false;
  mockCollectionSize = 384;
  mockUseNamedVectors = false;
  mockSentinelPayload = null;
  mockCreateCollectionThrows = null;
  // Drop any sentinel a prior test left behind so the no-drift default path
  // doesn't accidentally report `migrated: true`.
  if (existsSync(REBUILD_SENTINEL_PATH)) {
    rmSync(REBUILD_SENTINEL_PATH);
  }
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
      if (mockCreateCollectionThrows) {
        throw mockCreateCollectionThrows;
      }
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
        return [
          {
            id: "00000000-0000-0000-0000-000000000000",
            payload: mockSentinelPayload,
          },
        ];
      }
      return [];
    }

    async upsert(_name: string, _opts: unknown) {
      callLog.upsert++;
    }
  },
}));

import {
  clearRebuildSentinel,
  VellumQdrantClient,
} from "../persistence/embeddings/qdrant-client.js";

beforeEach(() => {
  resetMockState();
});

afterAll(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("Qdrant collection migration", () => {
  test("deletes and recreates collection on pure dimension mismatch", async () => {
    mockCollectionExists = true;
    mockUseNamedVectors = true;
    mockCollectionSize = 384; // Current collection has 384-dim vectors

    const client = new VellumQdrantClient({
      url: "http://localhost:6333",
      collection: "memory",
      vectorSize: 768, // New config expects 768-dim vectors
      onDisk: false,
      quantization: "none",
      embeddingModel: "gemini:gemini-embedding-2",
    });

    const result = await client.ensureCollection();

    // The v1 collection is not managed by the startup embedding reconcile, so
    // dimension drift is repaired here: delete + recreate, then rebuild_index
    // re-embeds from the SQLite cache via the lifecycle hook.
    expect(callLog.deleteCollection).toBe(1);
    expect(callLog.createCollection).toBe(1);
    expect(result.migrated).toBe(true);
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
      embeddingModel: "gemini:gemini-embedding-2", // New model
    });

    const result = await client.ensureCollection();

    expect(callLog.deleteCollection).toBe(1);
    expect(callLog.createCollection).toBe(1);
    // Sentinel should be written for the new model
    expect(callLog.upsert).toBe(1);
    expect(result.migrated).toBe(true);
  });

  test("leaves collection untouched when dimensions and model match", async () => {
    mockCollectionExists = true;
    mockUseNamedVectors = true;
    mockCollectionSize = 768;
    mockSentinelPayload = {
      _meta: true,
      embedding_model: "gemini:gemini-embedding-2",
    };

    const client = new VellumQdrantClient({
      url: "http://localhost:6333",
      collection: "memory",
      vectorSize: 768,
      onDisk: false,
      quantization: "none",
      embeddingModel: "gemini:gemini-embedding-2",
    });

    const result = await client.ensureCollection();

    expect(callLog.deleteCollection).toBe(0);
    expect(callLog.createCollection).toBe(0);
    expect(result.migrated).toBe(false);
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
      embeddingModel: "gemini:gemini-embedding-2",
    });

    const result = await client.ensureCollection();

    // No sentinel found → no model mismatch → collection kept
    expect(callLog.deleteCollection).toBe(0);
    expect(callLog.createCollection).toBe(0);
    expect(result.migrated).toBe(false);
  });

  test("writes sentinel point when creating a new collection", async () => {
    mockCollectionExists = false;

    const client = new VellumQdrantClient({
      url: "http://localhost:6333",
      collection: "memory",
      vectorSize: 768,
      onDisk: false,
      quantization: "none",
      embeddingModel: "gemini:gemini-embedding-2",
    });

    const result = await client.ensureCollection();

    expect(callLog.createCollection).toBe(1);
    // Sentinel upsert should be called
    expect(callLog.upsert).toBe(1);
    // Fresh collection, not a migration
    expect(result.migrated).toBe(false);
  });

  test("deletes and recreates collection when migrating from unnamed to named vectors", async () => {
    mockCollectionExists = true;
    mockUseNamedVectors = false; // Legacy unnamed vectors
    mockCollectionSize = 768;

    const client = new VellumQdrantClient({
      url: "http://localhost:6333",
      collection: "memory",
      vectorSize: 768, // Same dimension
      onDisk: false,
      quantization: "none",
      embeddingModel: "gemini:gemini-embedding-2",
    });

    const result = await client.ensureCollection();

    // Unnamed vectors should trigger delete + recreate with named vectors
    expect(callLog.deleteCollection).toBe(1);
    expect(callLog.createCollection).toBe(1);
    // Sentinel should be written for the new collection
    expect(callLog.upsert).toBe(1);
    expect(result.migrated).toBe(true);
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

    const result = await client.ensureCollection();

    expect(callLog.createCollection).toBe(1);
    // No sentinel should be written
    expect(callLog.upsert).toBe(0);
    // Fresh collection, not a migration
    expect(result.migrated).toBe(false);
  });
});

// The v1 collection lives outside the startup embedding reconcile, so a
// destructive dimension/model recreate reports `migrated: true` and the
// lifecycle hook enqueues `rebuild_index`. That signal is durable across a
// crash or Qdrant failure mid-recreate via an on-disk sentinel written before
// the delete — otherwise a delete-then-die would drop the v1 vectors silently.
describe("Qdrant v1 rebuild sentinel (durable migration signal)", () => {
  const makeClient = () =>
    new VellumQdrantClient({
      url: "http://localhost:6333",
      collection: "memory",
      vectorSize: 768,
      onDisk: false,
      quantization: "none",
      embeddingModel: "gemini:gemini-embedding-2",
    });

  test("preserves the rebuild signal across calls when createCollection fails after delete", async () => {
    // Dimension drift triggers the destructive recreate; createCollection then
    // throws, reproducing the exact data-loss window — the collection is gone
    // but the in-memory `migrated` signal never reaches the caller.
    mockCollectionExists = true;
    mockUseNamedVectors = true;
    mockCollectionSize = 384;
    mockCreateCollectionThrows = new Error("Qdrant transient failure");

    let firstError: unknown = null;
    try {
      await makeClient().ensureCollection();
    } catch (err) {
      firstError = err;
    }
    expect(firstError).not.toBeNull();
    expect(callLog.deleteCollection).toBe(1);
    // The sentinel written BEFORE the delete outlives the failed call.
    expect(existsSync(REBUILD_SENTINEL_PATH)).toBe(true);

    // Next startup: the collection is missing (delete succeeded), so a fresh
    // client recreates it empty — but must still report migrated:true from the
    // sentinel so the lifecycle hook enqueues rebuild_index.
    mockCreateCollectionThrows = null;
    mockCollectionExists = false;
    const result = await makeClient().ensureCollection();
    expect(result.migrated).toBe(true);
    expect(callLog.createCollection).toBeGreaterThanOrEqual(1);

    // Lifecycle hook clears the sentinel after enqueueing rebuild_index.
    await clearRebuildSentinel();
    expect(existsSync(REBUILD_SENTINEL_PATH)).toBe(false);
  });

  test("a leftover sentinel + freshly created collection reports migrated:true", async () => {
    // Crash-after-delete recovery: the sentinel is on disk and the collection
    // is absent, so the ensure path recreates it empty yet signals the owed
    // rebuild.
    writeFileSync(REBUILD_SENTINEL_PATH, "");
    mockCollectionExists = false;

    const result = await makeClient().ensureCollection();

    expect(callLog.createCollection).toBe(1);
    expect(result.migrated).toBe(true);
  });

  test("a leftover sentinel surfaces migrated:true even when the collection is already compatible", async () => {
    // Crash-after-recreate: the collection exists and matches, but the prior
    // boot died before enqueuing rebuild_index and clearing the sentinel.
    writeFileSync(REBUILD_SENTINEL_PATH, "");
    mockCollectionExists = true;
    mockUseNamedVectors = true;
    mockCollectionSize = 768;
    mockSentinelPayload = {
      _meta: true,
      embedding_model: "gemini:gemini-embedding-2",
    };

    const result = await makeClient().ensureCollection();

    // No destructive work — it just carries the owed rebuild forward.
    expect(callLog.deleteCollection).toBe(0);
    expect(callLog.createCollection).toBe(0);
    expect(result.migrated).toBe(true);
  });

  test("normal path: a compatible collection writes no sentinel and reports migrated:false", async () => {
    mockCollectionExists = true;
    mockUseNamedVectors = true;
    mockCollectionSize = 768;
    mockSentinelPayload = {
      _meta: true,
      embedding_model: "gemini:gemini-embedding-2",
    };

    const result = await makeClient().ensureCollection();

    expect(callLog.deleteCollection).toBe(0);
    expect(callLog.createCollection).toBe(0);
    expect(result.migrated).toBe(false);
    expect(existsSync(REBUILD_SENTINEL_PATH)).toBe(false);
  });

  test("clearRebuildSentinel is a no-op when no sentinel exists", async () => {
    expect(existsSync(REBUILD_SENTINEL_PATH)).toBe(false);
    await clearRebuildSentinel();
    expect(existsSync(REBUILD_SENTINEL_PATH)).toBe(false);
  });
});
