// ---------------------------------------------------------------------------
// retriever.test.ts — focused unit tests for loadContextMemory
//
// The full retrieval pipeline touches SQLite, Qdrant, LLM providers, and the
// embedding backend. These tests stub only the external boundaries that would
// otherwise reach out over the network (embedding backend, Qdrant search, LLM
// provider). Everything else (real in-process SQLite, real triggers/scoring)
// runs unmocked so the mocks do not leak across test files in a shared
// process.
//
// Focus: the plumbing added in PR 3 — surfacing the dense query vector
// (and the optional sparse vector) on ContextLoadResult so downstream callers
// can reuse them without re-embedding.
// ---------------------------------------------------------------------------

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Configurable embed-mock state — reset between tests.
let embedShouldThrow = false;
let embedVector: number[] = [0.1, 0.2, 0.3];

mock.module("../embed.js", () => ({
  embedWithRetry: async () => {
    if (embedShouldThrow) throw new Error("embedding backend down");
    return {
      vectors: [embedVector],
      provider: "test-provider",
      model: "test-model",
    };
  },
}));

mock.module("../embedding-backend.js", () => ({
  selectedBackendSupportsMultimodal: async () => false,
}));

mock.module("./graph-search.js", () => ({
  searchGraphNodes: async () => [],
}));

// Returning `null` from getConfiguredProvider causes rerankAndDedup and
// dedupCrossCategory to fall back to the candidate list without calling an
// LLM, keeping these tests fully offline.
mock.module("../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => null,
  userMessage: (text: string) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text }],
  }),
  extractToolUse: () => null,
}));

import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { AssistantConfig } from "../../config/types.js";
import { initializeDb, resetDb } from "../db.js";
import { InContextTracker } from "./injection.js";
import { loadContextMemory, retrieveForTurn } from "./retriever.js";

const TEST_CONFIG: AssistantConfig = { ...DEFAULT_CONFIG };

describe("loadContextMemory — query/sparse vector surfacing", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    embedShouldThrow = false;
    embedVector = [0.1, 0.2, 0.3];
    resetDb();
    initializeDb();
  });

  test("returns the dense queryVector when embedding succeeds", async () => {
    embedVector = [0.42, 0.5, 0.7];

    const result = await loadContextMemory({
      scopeId: "test-scope",
      recentSummaries: ["recent summary one", "recent summary two"],
      config: TEST_CONFIG,
    });

    expect(result.queryVector).toEqual([0.42, 0.5, 0.7]);
    // Sparse vector is reserved for future hybrid retrieval — currently not
    // produced inside loadContextMemory, so it should be undefined.
    expect(result.sparseVector).toBeUndefined();
  });

  test("returns undefined queryVector when the embedding backend throws", async () => {
    embedShouldThrow = true;

    const result = await loadContextMemory({
      scopeId: "test-scope",
      recentSummaries: ["recent summary"],
      config: TEST_CONFIG,
    });

    // Circuit-breaker path: embedding failure is swallowed; no throw.
    expect(result.queryVector).toBeUndefined();
    expect(result.sparseVector).toBeUndefined();
  });

  test("returns undefined queryVector when no summaries are provided", async () => {
    const result = await loadContextMemory({
      scopeId: "test-scope",
      recentSummaries: [],
      config: TEST_CONFIG,
    });

    expect(result.queryVector).toBeUndefined();
    expect(result.sparseVector).toBeUndefined();
  });

  test("ignores userQuery when dual-query logic is not yet implemented (PR 2 baseline)", async () => {
    const result = await loadContextMemory({
      scopeId: "test-scope",
      recentSummaries: ["summary"],
      userQuery: "ignore me for now",
      config: TEST_CONFIG,
    });
    expect(result.userQueryVector).toBeUndefined();
    expect(result.queryVector).toBeDefined();
  });
});

describe("retrieveForTurn — query/sparse vector surfacing", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    embedShouldThrow = false;
    embedVector = [0.1, 0.2, 0.3];
    resetDb();
    initializeDb();
  });

  test("returns the dense queryVector when embedding succeeds", async () => {
    embedVector = [0.9, 0.8, 0.7];

    const tracker = new InContextTracker();
    const result = await retrieveForTurn({
      assistantLastMessage: "What did we decide yesterday?",
      userLastMessage: "We decided to ship on Friday.",
      scopeId: "test-scope",
      config: TEST_CONFIG,
      tracker,
    });

    // Even though the scored candidate list is empty (mocked Qdrant returns
    // nothing), the queryVector should still be surfaced so the PKB hint
    // retriever can fire on every turn.
    expect(result.queryVector).toEqual([0.9, 0.8, 0.7]);
    expect(result.sparseVector).toBeUndefined();
  });

  test("returns undefined queryVector when the embedding backend throws", async () => {
    embedShouldThrow = true;

    const tracker = new InContextTracker();
    const result = await retrieveForTurn({
      assistantLastMessage: "hello",
      userLastMessage: "how are you?",
      scopeId: "test-scope",
      config: TEST_CONFIG,
      tracker,
    });

    // Circuit-breaker path: embedding failure is swallowed; no throw and no
    // vector surfaced.
    expect(result.queryVector).toBeUndefined();
    expect(result.sparseVector).toBeUndefined();
  });

  test("returns undefined queryVector when there is no text to embed", async () => {
    const tracker = new InContextTracker();
    const result = await retrieveForTurn({
      assistantLastMessage: "",
      userLastMessage: "",
      scopeId: "test-scope",
      config: TEST_CONFIG,
      tracker,
    });

    expect(result.queryVector).toBeUndefined();
    expect(result.sparseVector).toBeUndefined();
  });
});
