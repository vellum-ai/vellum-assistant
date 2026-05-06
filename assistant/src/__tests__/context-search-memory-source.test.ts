import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../config/schema.js";
import type {
  RecallEvidence,
  RecallSearchContext,
  RecallSearchResult,
} from "../memory/context-search/types.js";
import type { MemoryNode } from "../memory/graph/types.js";

const loggerModule = import.meta.resolve("../util/logger.js");
const embedModule = import.meta.resolve("../memory/embed.js");
const embeddingBackendModule = import.meta
  .resolve("../memory/embedding-backend.js");
const graphSearchModule = import.meta
  .resolve("../memory/graph/graph-search.js");
const graphStoreModule = import.meta.resolve("../memory/graph/store.js");
const memoryV2SourceModule = import.meta
  .resolve("../memory/context-search/sources/memory-v2.js");

const warnCalls: unknown[][] = [];
mock.module(loggerModule, () => ({
  getLogger: () => ({
    warn: (...args: unknown[]) => {
      warnCalls.push(args);
    },
  }),
}));

let embedShouldThrow = false;
let embedVectors: number[][] = [[0.1, 0.2, 0.3]];
const embedCalls: Array<{
  config: unknown;
  texts: unknown[];
  opts?: { signal?: AbortSignal };
}> = [];

mock.module(embedModule, () => ({
  embedWithRetry: async (
    config: unknown,
    texts: unknown[],
    opts?: { signal?: AbortSignal },
  ) => {
    embedCalls.push({ config, texts, opts });
    if (embedShouldThrow) {
      throw new Error("embedding backend down");
    }
    return {
      vectors: embedVectors,
      provider: "test-provider",
      model: "test-model",
    };
  },
}));

mock.module(embeddingBackendModule, () => ({
  embedWithBackend: async () => ({
    provider: "test",
    model: "test-model",
    vectors: [[0.1, 0.2, 0.3]],
  }),
  generateSparseEmbedding: (text: string) =>
    text.trim().length === 0
      ? { indices: [], values: [] }
      : { indices: [1], values: [1] },
}));

type SearchCall = {
  vector: number[];
  limit: number;
  sparseVector?: { indices: number[]; values: number[] };
};

let searchShouldThrow = false;
let searchHits: Array<{ nodeId: string; score: number; text: string }> = [];
const searchCalls: SearchCall[] = [];

mock.module(graphSearchModule, () => ({
  searchGraphNodes: async (
    vector: number[],
    limit: number,
    sparseVector?: { indices: number[]; values: number[] },
  ) => {
    searchCalls.push({ vector, limit, sparseVector });
    if (searchShouldThrow) {
      throw new Error("qdrant unavailable");
    }
    return searchHits;
  },
}));

let hydratedNodes: MemoryNode[] = [];
const getNodesByIdsCalls: string[][] = [];

mock.module(graphStoreModule, () => ({
  getNodesByIds: (ids: string[]) => {
    getNodesByIdsCalls.push(ids);
    return hydratedNodes;
  },
}));

const v2Calls: Array<{
  query: string;
  context: RecallSearchContext;
  limit: number;
}> = [];
let v2EvidenceReturn: RecallEvidence[] = [];

mock.module(memoryV2SourceModule, () => ({
  searchMemoryV2Source: async (
    query: string,
    context: RecallSearchContext,
    limit: number,
  ): Promise<RecallSearchResult> => {
    v2Calls.push({ query, context, limit });
    return { evidence: v2EvidenceReturn };
  },
}));

const { searchMemorySource } =
  await import("../memory/context-search/sources/memory.js");

describe("searchMemorySource", () => {
  beforeEach(() => {
    warnCalls.length = 0;
    embedShouldThrow = false;
    embedVectors = [[0.1, 0.2, 0.3]];
    embedCalls.length = 0;
    searchShouldThrow = false;
    searchHits = [];
    searchCalls.length = 0;
    hydratedNodes = [];
    getNodesByIdsCalls.length = 0;
    v2Calls.length = 0;
    v2EvidenceReturn = [];
  });

  test("hydrates graph hits into memory recall evidence", async () => {
    const first = makeNode({
      id: "node-a",
      content: "Alice prefers concise deployment notes.",
      type: "semantic",
      created: 1_700_000_000_000,
      confidence: 0.8,
      significance: 0.7,
      lastAccessed: 111,
    });
    const second = makeNode({
      id: "node-b",
      content: "Bob uses the release checklist before shipping.",
      type: "procedural",
      created: 1_700_000_100_000,
      confidence: 0.9,
      significance: 0.6,
      lastAccessed: 222,
    });
    searchHits = [
      { nodeId: "node-b", score: 0.91, text: "release checklist" },
      { nodeId: "node-a", score: 0.84, text: "deployment notes" },
    ];
    hydratedNodes = [first, second];

    const result = await searchMemorySource("release notes", makeContext(), 4);

    expect(result.evidence).toEqual([
      {
        id: "memory:node-b",
        source: "memory",
        title: "Procedural memory",
        locator: "node-b",
        excerpt: "Bob uses the release checklist before shipping.",
        timestampMs: 1_700_000_100_000,
        score: 0.91,
        metadata: {
          confidence: 0.9,
          significance: 0.6,
          type: "procedural",
        },
      },
      {
        id: "memory:node-a",
        source: "memory",
        title: "Semantic memory",
        locator: "node-a",
        excerpt: "Alice prefers concise deployment notes.",
        timestampMs: 1_700_000_000_000,
        score: 0.84,
        metadata: {
          confidence: 0.8,
          significance: 0.7,
          type: "semantic",
        },
      },
    ]);
    expect(getNodesByIdsCalls).toEqual([["node-b", "node-a"]]);
    expect(first.lastAccessed).toBe(111);
    expect(second.lastAccessed).toBe(222);
  });

  test("forwards abort signal to graph search dependencies", async () => {
    const controller = new AbortController();
    searchHits = [];

    await searchMemorySource(
      "deployment checklist",
      makeContext({ signal: controller.signal }),
      3,
    );

    expect(embedCalls).toEqual([
      {
        config: expect.any(Object),
        texts: ["deployment checklist"],
        opts: { signal: controller.signal },
      },
    ]);
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]).toMatchObject({
      vector: [0.1, 0.2, 0.3],
      limit: 3,
    });
    expect(searchCalls[0]?.sparseVector?.indices.length).toBeGreaterThan(0);
  });

  test("filters gone memories after hydration", async () => {
    searchHits = [
      { nodeId: "live-node", score: 0.8, text: "live" },
      { nodeId: "gone-node", score: 0.7, text: "gone" },
    ];
    hydratedNodes = [
      makeNode({ id: "live-node", content: "Live memory" }),
      makeNode({
        id: "gone-node",
        content: "Gone memory",
        fidelity: "gone",
      }),
    ];

    const result = await searchMemorySource("memory", makeContext(), 10);

    expect(result.evidence.map((evidence) => evidence.locator)).toEqual([
      "live-node",
    ]);
  });

  test("returns empty evidence when embedding yields no dense vector", async () => {
    embedVectors = [];

    const result = await searchMemorySource("memory", makeContext(), 5);

    expect(result).toEqual({ evidence: [] });
    expect(searchCalls).toHaveLength(0);
    expect(getNodesByIdsCalls).toHaveLength(0);
  });

  test("continues with dense search when the sparse vector is empty", async () => {
    searchHits = [{ nodeId: "node-a", score: 0.72, text: "" }];
    hydratedNodes = [makeNode({ id: "node-a", content: "Dense-only match" })];

    const result = await searchMemorySource("   ", makeContext(), 5);

    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]?.sparseVector).toEqual({ indices: [], values: [] });
    expect(result.evidence.map((evidence) => evidence.excerpt)).toEqual([
      "Dense-only match",
    ]);
  });

  test("returns empty evidence and warns when embedding fails", async () => {
    embedShouldThrow = true;

    const result = await searchMemorySource("memory", makeContext(), 5);

    expect(result).toEqual({ evidence: [] });
    expect(searchCalls).toHaveLength(0);
    expect(warnCalls).toHaveLength(1);
    expect(String(warnCalls[0]?.[1])).toContain(
      "Failed to embed memory recall query",
    );
  });

  test("returns empty evidence and warns when graph search fails", async () => {
    searchShouldThrow = true;

    const result = await searchMemorySource("memory", makeContext(), 5);

    expect(result).toEqual({ evidence: [] });
    expect(getNodesByIdsCalls).toHaveLength(0);
    expect(warnCalls).toHaveLength(1);
    expect(String(warnCalls[0]?.[1])).toContain(
      "Failed to search memory graph for recall",
    );
  });

  test("routes to v2 source when memory.v2.enabled is on", async () => {
    v2EvidenceReturn = [
      {
        id: "memory:v2:alice",
        source: "memory",
        title: "alice",
        locator: "memory/concepts/alice.md",
        excerpt: "Alice prefers concise notes.",
        score: 0.9,
        metadata: {
          path: "memory/concepts/alice.md",
          slug: "alice",
          retrieval: "activation",
        },
      },
    ];

    const result = await searchMemorySource(
      "alice",
      makeContext({
        config: makeV2EnabledConfig(),
      }),
      6,
    );

    expect(v2Calls).toHaveLength(1);
    expect(v2Calls[0]?.query).toBe("alice");
    expect(v2Calls[0]?.limit).toBe(6);
    expect(searchCalls).toHaveLength(0);
    expect(getNodesByIdsCalls).toHaveLength(0);
    expect(result.evidence.map((e) => e.locator)).toEqual([
      "memory/concepts/alice.md",
    ]);
  });

  test("stays on legacy path when memory.v2.enabled is off", async () => {
    searchHits = [{ nodeId: "node-a", score: 0.7, text: "" }];
    hydratedNodes = [makeNode({ id: "node-a", content: "Legacy hit" })];

    await searchMemorySource(
      "alice",
      makeContext({ config: makeV2DisabledConfig() }),
      5,
    );

    expect(v2Calls).toHaveLength(0);
    expect(searchCalls).toHaveLength(1);
  });
});

function makeV2EnabledConfig(): AssistantConfig {
  return {
    memory: {
      v2: { enabled: true },
    },
  } as unknown as AssistantConfig;
}

function makeV2DisabledConfig(): AssistantConfig {
  return {
    memory: {
      v2: { enabled: false },
    },
  } as unknown as AssistantConfig;
}

function makeContext(
  overrides: Partial<RecallSearchContext> = {},
): RecallSearchContext {
  return {
    workingDir: "/tmp/example-workspace",
    conversationId: "conv-123",
    config: { memory: { v2: { enabled: false } } } as AssistantConfig,
    ...overrides,
  };
}

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  const now = 1_700_000_000_000;
  return {
    id: "node-123",
    content: "Memory content",
    type: "semantic",
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
    fidelity: "clear",
    confidence: 0.75,
    significance: 0.5,
    stability: 1,
    reinforcementCount: 0,
    lastReinforced: now,
    sourceConversations: ["conv-123"],
    sourceType: "direct",
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
    scopeId: "scope-default",
    ...overrides,
  };
}
