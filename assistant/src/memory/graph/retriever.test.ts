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
let embedCallCount = 0;
// Optional input-aware router. When set, overrides the default single-vector
// mock behavior: takes the first text input and returns a matching vector.
let embedRouter: ((text: string) => number[]) | null = null;

mock.module("../embed.js", () => ({
  embedWithRetry: async (
    _config: unknown,
    texts: unknown[],
    _opts?: unknown,
  ) => {
    embedCallCount++;
    if (embedShouldThrow) throw new Error("embedding backend down");
    const firstText = typeof texts[0] === "string" ? texts[0] : "";
    const vector = embedRouter ? embedRouter(firstText) : embedVector;
    return {
      vectors: [vector],
      provider: "test-provider",
      model: "test-model",
    };
  },
}));

mock.module("../embedding-backend.js", () => ({
  selectedBackendSupportsMultimodal: async () => false,
}));

// Optional input-aware search router. When set, chooses a candidate list
// based on the query vector's identity (vector equality on the first 3 dims).
type SearchHit = { nodeId: string; score: number };
let searchRouter: ((vector: number[]) => SearchHit[]) | null = null;

mock.module("./graph-search.js", () => ({
  searchGraphNodes: async (vector: number[]) => {
    if (searchRouter) return searchRouter(vector);
    return [];
  },
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
import { initializeDb, resetDb, resetTestTables } from "../db.js";
import { InContextTracker } from "./injection.js";
import { loadContextMemory, retrieveForTurn } from "./retriever.js";
import { createNode } from "./store.js";
import type { NewNode } from "./types.js";

const TEST_CONFIG: AssistantConfig = { ...DEFAULT_CONFIG };

function makeCapabilityNode(content: string, capId: string): NewNode {
  const now = Date.now();
  return {
    content,
    type: "procedural",
    created: now,
    lastAccessed: now,
    lastConsolidated: now,
    eventDate: null,
    emotionalCharge: {
      valence: 0,
      intensity: 0,
      decayCurve: "linear",
      decayRate: 0,
      originalIntensity: 0,
    },
    fidelity: "vivid",
    confidence: 1,
    significance: 0.5,
    stability: 14,
    reinforcementCount: 0,
    lastReinforced: now,
    sourceConversations: [`capability:skill:${capId}`],
    sourceType: "direct",
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
    scopeId: "default",
  };
}

describe("loadContextMemory — query/sparse vector surfacing", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    embedShouldThrow = false;
    embedVector = [0.1, 0.2, 0.3];
    embedCallCount = 0;
    embedRouter = null;
    searchRouter = null;
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

});

describe("retrieveForTurn — query/sparse vector surfacing", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    embedShouldThrow = false;
    embedVector = [0.1, 0.2, 0.3];
    embedCallCount = 0;
    embedRouter = null;
    searchRouter = null;
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

describe("loadContextMemory — dual-query capability ranking (PR 3)", () => {
  // Capture seeded capability node IDs so the searchGraphNodes mock can
  // reference them by ID (the mock runs at call time, not seed time).
  let inboxNodeId = "";
  let heartbeatNodeId = "";
  let watchNodeId = "";

  // Build a config where capabilityReserve=1 so the ranking code actually
  // prunes (it only prunes when capabilityNodes.length > capabilityReserve).
  const DUAL_QUERY_CONFIG: AssistantConfig = structuredClone(DEFAULT_CONFIG);
  DUAL_QUERY_CONFIG.memory.retrieval.injection.contextLoad.capabilityReserve =
    1;

  // Keyword-routed embed: any text that contains a topic keyword returns a
  // one-hot vector identifying that topic. Anything else falls back to a
  // neutral default vector. This lets tests assert which vector ended up
  // driving the capability-reserve decision.
  function keywordEmbedRouter(text: string): number[] {
    const lowered = text.toLowerCase();
    if (lowered.includes("inbox")) return [1, 0, 0];
    if (lowered.includes("heartbeat") || lowered.includes("readiness"))
      return [0, 1, 0];
    if (lowered.includes("bridgerton") || lowered.includes("watch"))
      return [0, 0, 1];
    return [0.1, 0.1, 0.1];
  }

  // Vector-routed search: returns the capability node aligned with the query
  // vector as the top hit, with the others as weak filler.
  function vectorSearchRouter(vector: number[]): SearchHit[] {
    const [a = 0, b = 0, c = 0] = vector;
    if (a === 1 && b === 0 && c === 0) {
      return [
        { nodeId: inboxNodeId, score: 0.9 },
        { nodeId: heartbeatNodeId, score: 0.1 },
        { nodeId: watchNodeId, score: 0.05 },
      ];
    }
    if (a === 0 && b === 1 && c === 0) {
      return [
        { nodeId: heartbeatNodeId, score: 0.9 },
        { nodeId: inboxNodeId, score: 0.1 },
        { nodeId: watchNodeId, score: 0.05 },
      ];
    }
    if (a === 0 && b === 0 && c === 1) {
      return [
        { nodeId: watchNodeId, score: 0.9 },
        { nodeId: inboxNodeId, score: 0.1 },
        { nodeId: heartbeatNodeId, score: 0.05 },
      ];
    }
    // Neutral default — return nothing so it can't accidentally dominate.
    return [];
  }

  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    embedShouldThrow = false;
    embedVector = [0.1, 0.2, 0.3];
    embedCallCount = 0;
    embedRouter = null;
    searchRouter = null;
    resetTestTables(
      "memory_graph_triggers",
      "memory_graph_edges",
      "memory_graph_nodes",
    );

    const inbox = createNode(
      makeCapabilityNode(
        'The "Inbox Cleanup" skill (inbox-cleanup) is available. Run a high-recall, multi-pass email inbox cleanup. Use when: when user asks to clean up email inbox.',
        "inbox-cleanup",
      ),
    );
    const heartbeat = createNode(
      makeCapabilityNode(
        'The "Heartbeat" skill (heartbeat) is available. Body temperature and readiness check-ins. Use when: user asks about daily readiness.',
        "heartbeat",
      ),
    );
    const watch = createNode(
      makeCapabilityNode(
        'The "Watch Together" skill (watch-together) is available. Co-watch video. Use when: user asks about watching Bridgerton or other shows.',
        "watch-together",
      ),
    );
    inboxNodeId = inbox.id;
    heartbeatNodeId = heartbeat.id;
    watchNodeId = watch.id;
  });

  // Use a long summary so the user-query short-circuit guard does not fire.
  const LONG_HEARTBEAT_SUMMARY =
    "User mentioned their heartbeat check-in this morning and we discussed " +
    "daily readiness routines, body temperature monitoring, and how the " +
    "heartbeat skill has been helping them track readiness patterns over " +
    "the last several weeks. We also touched on journaling and sleep data.";

  test("userQuery drives capability-reserve ranking over summary", async () => {
    embedRouter = keywordEmbedRouter;
    searchRouter = vectorSearchRouter;

    const result = await loadContextMemory({
      scopeId: "default",
      recentSummaries: [LONG_HEARTBEAT_SUMMARY],
      userQuery: "clean up my inbox",
      config: DUAL_QUERY_CONFIG,
    });

    expect(result.userQueryVector).toEqual([1, 0, 0]);
    const reservedIds = new Set(result.nodes.map((s) => s.node.id));
    expect(reservedIds.has(inboxNodeId)).toBe(true);
    expect(reservedIds.has(heartbeatNodeId)).toBe(false);
  });

  test("without userQuery, summary-based ranking picks the heartbeat capability", async () => {
    embedRouter = keywordEmbedRouter;
    searchRouter = vectorSearchRouter;

    const result = await loadContextMemory({
      scopeId: "default",
      recentSummaries: [LONG_HEARTBEAT_SUMMARY],
      config: DUAL_QUERY_CONFIG,
    });

    expect(result.userQueryVector).toBeUndefined();
    const reservedIds = new Set(result.nodes.map((s) => s.node.id));
    expect(reservedIds.has(heartbeatNodeId)).toBe(true);
  });

  test("short-circuits the dedicated embed when userQuery dominates summary length", async () => {
    embedRouter = keywordEmbedRouter;
    searchRouter = vectorSearchRouter;

    // Summary is short, user query is much longer (>= half summary length)
    // so the short-circuit kicks in and we only pay for the summary embed.
    const result = await loadContextMemory({
      scopeId: "default",
      recentSummaries: ["hi"],
      userQuery:
        "this is a dramatically longer user query that easily dominates the summary text length",
      config: DUAL_QUERY_CONFIG,
    });

    expect(result.userQueryVector).toBeUndefined();
    expect(embedCallCount).toBe(1);
  });
});
