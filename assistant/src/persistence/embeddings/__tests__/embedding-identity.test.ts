import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../../config/types.js";

const CONFIG = {
  memory: { qdrant: { url: "http://127.0.0.1:6333", vectorSize: 768 } },
} as unknown as AssistantConfig;

// ── Stub selectEmbeddingBackend + the billing breaker ──────────────
let backendToReturn: {
  provider: string;
  model: string;
  embed: (inputs: string[]) => Promise<number[][]>;
} | null = null;
let breakerOpen = false;
let selectBackendThrows = false;

const selectEmbeddingBackendMock = mock(async () => {
  if (selectBackendThrows) throw new Error("credential store unavailable");
  return {
    backend: backendToReturn,
    reason: backendToReturn ? null : "no backend",
  };
});
// probeBackendDimension delegates the measurement to resolveBackendDimension;
// the mock mirrors the real resolver's "embed → vector length, null on throw"
// contract so these tests drive behavior through the stub backend's embed().
const resolveBackendDimensionMock = mock(
  async (backend: { embed: (inputs: string[]) => Promise<number[][]> }) => {
    try {
      const [vector] = await backend.embed(["embedding dimension probe"]);
      return vector?.length ?? null;
    } catch {
      return null;
    }
  },
);
mock.module("../embedding-backend.js", () => ({
  selectEmbeddingBackend: selectEmbeddingBackendMock,
  resolveBackendDimension: resolveBackendDimensionMock,
}));

mock.module("../embedding-billing-breaker.js", () => ({
  isEmbeddingBillingBreakerOpen: () => breakerOpen,
}));

// ── Stub the Qdrant REST client ────────────────────────────────────
let collectionExistsResult = { exists: true };
let getCollectionResult: unknown = {
  config: { params: { vectors: { dense: { size: 768 } } } },
};
let collectionExistsThrows = false;
let getCollectionThrows = false;

const collectionExistsMock = mock(async () => {
  if (collectionExistsThrows) throw new Error("qdrant down");
  return collectionExistsResult;
});
const getCollectionMock = mock(async () => {
  if (getCollectionThrows) throw new Error("qdrant probe failed");
  return getCollectionResult;
});
mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    collectionExists = collectionExistsMock;
    getCollection = getCollectionMock;
  },
}));

const { probeBackendDimension, readConceptPageCollectionDim } =
  await import("../embedding-identity.js");

describe("probeBackendDimension", () => {
  beforeEach(() => {
    breakerOpen = false;
    selectBackendThrows = false;
    backendToReturn = {
      provider: "openai",
      model: "text-embedding-3-small",
      embed: async () => [new Array(1536).fill(0)],
    };
  });
  afterEach(() => {
    selectEmbeddingBackendMock.mockClear();
  });

  test("returns the measured dimension on success", async () => {
    const result = await probeBackendDimension(CONFIG);
    expect(result).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dim: 1536,
    });
  });

  test("returns null when the billing breaker is open", async () => {
    breakerOpen = true;
    expect(await probeBackendDimension(CONFIG)).toBeNull();
    // Breaker short-circuits before selecting a backend.
    expect(selectEmbeddingBackendMock).not.toHaveBeenCalled();
  });

  test("returns null when no backend is selectable", async () => {
    backendToReturn = null;
    expect(await probeBackendDimension(CONFIG)).toBeNull();
  });

  test("returns null when the backend embed call throws", async () => {
    backendToReturn = {
      provider: "openai",
      model: "text-embedding-3-small",
      embed: async () => {
        throw new Error("provider unreachable");
      },
    };
    expect(await probeBackendDimension(CONFIG)).toBeNull();
  });

  test("returns null (does not reject) when backend selection rejects", async () => {
    // `selectEmbeddingBackend` resolves provider credentials, which reject on a
    // non-timeout credential-store error. The probe must uphold its never-throws
    // contract so the reconcile defers instead of crashing.
    selectBackendThrows = true;
    expect(await probeBackendDimension(CONFIG)).toBeNull();
  });
});

describe("readConceptPageCollectionDim", () => {
  beforeEach(() => {
    collectionExistsResult = { exists: true };
    getCollectionResult = {
      config: { params: { vectors: { dense: { size: 768 } } } },
    };
    collectionExistsThrows = false;
    getCollectionThrows = false;
  });

  test("returns the committed dense vector size", async () => {
    expect(await readConceptPageCollectionDim(CONFIG)).toBe(768);
  });

  test("returns null only when the collection is confirmed absent", async () => {
    collectionExistsResult = { exists: false };
    expect(await readConceptPageCollectionDim(CONFIG)).toBeNull();
  });

  test("throws when an existing collection's dense size is unreadable", async () => {
    // Collection exists but the dense vector size is missing: "unknown" must
    // not be reported as "absent" (which the reconcile reads as a fresh
    // install), so this is an error.
    getCollectionResult = { config: { params: { vectors: {} } } };
    expect(readConceptPageCollectionDim(CONFIG)).rejects.toThrow();
  });

  test("propagates a Qdrant read failure (existence check throws)", async () => {
    // A transient Qdrant outage must propagate rather than be misread as a
    // confirmed-absent collection, so the reconcile defers instead of committing
    // a new dimension while the old collection still exists.
    collectionExistsThrows = true;
    expect(readConceptPageCollectionDim(CONFIG)).rejects.toThrow("qdrant down");
  });

  test("propagates a Qdrant read failure (getCollection throws)", async () => {
    getCollectionThrows = true;
    expect(readConceptPageCollectionDim(CONFIG)).rejects.toThrow(
      "qdrant probe failed",
    );
  });
});
