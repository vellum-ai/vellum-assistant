import { afterEach, describe, expect, mock, test } from "bun:test";

import type { MemoryConfig } from "../../config/schemas/memory.js";
import { userMessage } from "../../providers/provider-send-message.js";
import type { Message } from "../../providers/types.js";
import {
  assembleContextBlock,
  assembleInjectionBlock,
} from "../graph/injection.js";
import type { MemoryNode, ScoredNode } from "../graph/types.js";
import { wrapMemoryBlock } from "../memory-marker.js";
import type { MemoryProviderContext } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY_MS = 1000 * 60 * 60 * 24;

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "node-1",
    content: "Sidd prefers rg over grep.",
    type: "episodic",
    created: Date.now() - 5 * DAY_MS,
    lastAccessed: Date.now(),
    lastConsolidated: Date.now(),
    eventDate: null,
    emotionalCharge: {
      valence: 0,
      intensity: 0,
      decayCurve: "linear",
      decayRate: 0.05,
      originalIntensity: 0,
    },
    fidelity: "vivid",
    confidence: 0.8,
    significance: 0.5,
    stability: 14,
    reinforcementCount: 0,
    lastReinforced: Date.now(),
    sourceConversations: ["conv-1"],
    sourceType: "direct",
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
    scopeId: "default",
    ...overrides,
  };
}

function makeScored(overrides: Partial<MemoryNode> = {}): ScoredNode {
  return {
    node: makeNode(overrides),
    score: 0.5,
    scoreBreakdown: {
      semanticSimilarity: 0.5,
      effectiveSignificance: 0.5,
      emotionalIntensity: 0,
      temporalBoost: 0,
      recencyBoost: 0.5,
      triggerBoost: 0,
      activationBoost: 0,
    },
  };
}

const ZERO_METRICS = {
  semanticHits: 0,
  mergedCount: 0,
  selectedCount: 0,
  tier1Count: 0,
  tier2Count: 0,
  hybridSearchLatencyMs: 0,
  sparseVectorUsed: false,
  embeddingProvider: null,
  embeddingModel: null,
  queryContext: null,
  topCandidates: [],
};

const SEEDED_NODES = [makeScored({ id: "n1", content: "Fact one." })];
const SEEDED_SERENDIPITY = [makeScored({ id: "n2", content: "Fact two." })];

afterEach(() => {
  mock.restore();
});

/**
 * Load the adapter with the heavy graph retriever + config mocked out so the
 * test exercises the adapter's mapping logic (retrieve → assemble → wrap →
 * InjectionBlock) without touching Qdrant/embeddings.
 */
async function loadProviderWithMocks(
  nodes: {
    context: ScoredNode[];
    turn: ScoredNode[];
    serendipity: ScoredNode[];
  } = {
    context: SEEDED_NODES,
    turn: SEEDED_NODES,
    serendipity: SEEDED_SERENDIPITY,
  },
) {
  mock.module("../../config/loader.js", () => ({
    getConfig: () => ({}) as never,
  }));
  mock.module("../graph/retriever.js", () => ({
    loadContextMemory: async () => ({
      nodes: nodes.context,
      serendipityNodes: nodes.serendipity,
      triggeredNodes: [],
      latencyMs: 0,
      metrics: ZERO_METRICS,
    }),
    retrieveForTurn: async () => ({
      nodes: nodes.turn,
      serendipityNodes: [],
      triggeredNodes: [],
      latencyMs: 0,
      metrics: ZERO_METRICS,
    }),
  }));
  const { GraphMemoryProvider } = await import("./graph-provider.js");
  return GraphMemoryProvider;
}

function ctx(messages: Message[]): MemoryProviderContext {
  return {
    conversationId: "conv-1",
    requestId: "req-1",
    messages,
    config: {} as MemoryConfig,
    turnIndex: 0,
    trust: { sourceChannel: "vellum", trustClass: "guardian" },
  };
}

describe("GraphMemoryProvider", () => {
  test("identifies as the graph provider", async () => {
    const provider = await loadProviderWithMocks();
    expect(provider.id).toBe("graph");
  });

  test("retrieveForContext renders the same wrapped block as the direct graph path", async () => {
    const provider = await loadProviderWithMocks();
    const blocks = await provider.retrieveForContext(
      ctx([userMessage("what did I say about grep?")]),
    );

    const expected = wrapMemoryBlock(
      assembleContextBlock(SEEDED_NODES, {
        serendipityNodes: SEEDED_SERENDIPITY,
      }),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(expected);
    expect(blocks[0].placement).toBe("prepend-user-tail");
    expect(blocks[0].id).toBeString();
  });

  test("retrieveForTurn renders the same wrapped block as the direct graph path", async () => {
    const provider = await loadProviderWithMocks();
    const blocks = await provider.retrieveForTurn(
      ctx([
        {
          role: "assistant",
          content: [{ type: "text", text: "Earlier reply." }],
        },
        userMessage("follow-up question"),
      ]),
    );

    const expected = wrapMemoryBlock(assembleInjectionBlock(SEEDED_NODES));

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(expected);
    expect(blocks[0].placement).toBe("after-memory-prefix");
  });

  test("returns no blocks when retrieval yields no nodes", async () => {
    const provider = await loadProviderWithMocks({
      context: [],
      turn: [],
      serendipity: [],
    });

    expect(await provider.retrieveForContext(ctx([userMessage("hi")]))).toEqual(
      [],
    );
    expect(await provider.retrieveForTurn(ctx([userMessage("hi")]))).toEqual(
      [],
    );
  });

  test("provideTools exposes remember and recall definitions", async () => {
    const provider = await loadProviderWithMocks();
    const names = provider.provideTools().map((t) => t.name);
    expect(names).toContain("remember");
    expect(names).toContain("recall");
  });

  test("onTurnCommit enqueues a retrospective without throwing", async () => {
    const enqueue = mock(
      (_args: { conversationId: string; trigger: string }) => {},
    );
    mock.module("../memory-retrospective-enqueue.js", () => ({
      enqueueMemoryRetrospectiveIfEnabled: enqueue,
    }));
    mock.module("../../config/loader.js", () => ({
      getConfig: () => ({}) as never,
    }));
    mock.module("../graph/retriever.js", () => ({
      loadContextMemory: async () => ({ nodes: [] }),
      retrieveForTurn: async () => ({ nodes: [] }),
    }));
    const { GraphMemoryProvider } = await import("./graph-provider.js");

    await GraphMemoryProvider.onTurnCommit(ctx([userMessage("hi")]));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toEqual({
      conversationId: "conv-1",
      trigger: "lifecycle",
    });
  });
});
