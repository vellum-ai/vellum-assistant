import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../config/schema.js";
import type { DeterministicRecallSearchResult } from "../memory/context-search/search.js";
import type {
  RecallEvidence,
  RecallInput,
  RecallSearchContext,
} from "../memory/context-search/types.js";

interface CapturedSearch {
  input: RecallInput;
  context: RecallSearchContext;
}

const capturedSearches: CapturedSearch[] = [];
const getConfiguredProviderCalls: string[] = [];
const testConfig = {} as AssistantConfig;

mock.module("../config/loader.js", () => ({
  API_KEY_PROVIDERS: [],
  getConfig: () => testConfig,
  getConfigReadOnly: () => testConfig,
  loadConfig: () => testConfig,
}));

mock.module("../security/secure-keys.js", () => ({
  getProviderKeyAsync: async () => undefined,
  getSecureKeyAsync: async () => undefined,
  setSecureKeyAsync: async () => true,
}));

mock.module("../oauth/oauth-store.js", () => ({
  getActiveConnection: () => undefined,
  getConnectionByProvider: () => undefined,
  getProvider: () => undefined,
  isProviderConnected: () => false,
  listConnections: () => [],
  listProviders: () => [],
}));

mock.module("../memory/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => undefined,
  embedWithBackend: async () => [],
  generateSparseEmbedding: () => ({ indices: [], values: [] }),
  getMemoryBackendStatus: async () => ({
    enabled: false,
    degraded: false,
    reason: null,
    provider: null,
    model: null,
  }),
  selectedBackendSupportsMultimodal: async () => false,
}));

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: () => ({ id: "msg-1" }),
  createConversation: () => ({ id: "conv-1" }),
  deleteConversation: () => true,
  getAssistantMessageIdsInTurn: () => [],
  getConversation: () => null,
  getConversationHostAccess: () => false,
  getConversationOverrideProfile: () => undefined,
  getConversationSource: () => null,
  getMessageById: () => null,
  getMessages: () => [],
  parseConversation: (row: unknown) => row,
  updateConversationTitle: () => undefined,
  updateConversationUsage: () => undefined,
}));

mock.module("../memory/graph/compaction.js", () => ({
  compactLongMemories: async () => ({
    scanned: 0,
    candidates: 0,
    compacted: 0,
    skipped: 0,
    failed: 0,
  }),
}));

mock.module("../memory/indexer.js", () => ({
  enqueueBackfillJob: () => "backfill-job",
  enqueueRebuildIndexJob: () => "rebuild-job",
  MIN_SEGMENT_CHARS: 50,
}));

mock.module("../memory/qdrant-circuit-breaker.js", () => ({
  isQdrantBreakerOpen: () => false,
  shouldAllowQdrantProbe: () => true,
  withQdrantBreaker: async (fn: () => unknown) => fn(),
}));

mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    deleteByTarget: async () => undefined,
  }),
  initQdrantClient: () => undefined,
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

function makeEvidence(
  id: string,
  overrides: Partial<RecallEvidence> = {},
): RecallEvidence {
  return {
    id,
    source: "memory",
    title: `${id} title`,
    locator: `${id}:locator`,
    excerpt: `${id} excerpt`,
    score: 0.75,
    timestampMs: 1234,
    metadata: {
      confidence: 0.8,
      significance: 0.6,
    },
    ...overrides,
  };
}

mock.module("../memory/context-search/search.js", () => ({
  runDeterministicRecallSearch: async (
    input: RecallInput,
    context: RecallSearchContext,
  ): Promise<DeterministicRecallSearchResult> => {
    capturedSearches.push({ input, context });
    return {
      input: {
        query: input.query,
        sources: input.sources ?? [],
        maxResults: input.max_results ?? 8,
        depth: input.depth ?? "standard",
        sourceRounds: 1,
      },
      evidence: [makeEvidence("memory:launch")],
      searchedSources: (input.sources ?? []).map((source) => ({
        source,
        status: "searched" as const,
        evidenceCount: source === "memory" ? 1 : 0,
      })),
    };
  },
}));

mock.module("../providers/provider-send-message.js", () => ({
  extractToolUse: () => null,
  getConfiguredProvider: async (callSite: string) => {
    getConfiguredProviderCalls.push(callSite);
    return null;
  },
  userMessage: (text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
  }),
}));

const { queryMemory } = await import("../memory/admin.js");
const { getWorkspaceDir } = await import("../util/platform.js");

describe("memory admin recall", () => {
  beforeEach(() => {
    capturedSearches.length = 0;
    getConfiguredProviderCalls.length = 0;
  });

  test("uses safe admin sources", async () => {
    const result = await queryMemory("launch notes", "conv-admin");

    expect(capturedSearches).toHaveLength(1);
    expect(capturedSearches[0].input).toEqual({
      query: "launch notes",
      sources: ["memory", "conversations", "pkb"],
    });
    expect(capturedSearches[0].context).toMatchObject({
      workingDir: getWorkspaceDir(),
      conversationId: "conv-admin",
      config: testConfig,
    });
    expect(capturedSearches[0].input.sources).not.toContain("workspace");
    expect(result).toEqual({
      results: [
        {
          id: "memory:launch",
          content: "memory:launch excerpt",
          type: "memory",
          confidence: 0.8,
          significance: 0.6,
          score: 0.75,
          created: 1234,
        },
      ],
      mode: "memory",
      query: "launch notes",
    });
  });

  test("does not invoke a provider for deterministic recall", async () => {
    await queryMemory("offline recall", "missing-conversation");

    expect(capturedSearches).toHaveLength(1);
    expect(capturedSearches[0].context).toMatchObject({
      workingDir: getWorkspaceDir(),
      conversationId: "missing-conversation",
    });
    expect(capturedSearches[0].input.sources).toEqual([
      "memory",
      "conversations",
      "pkb",
    ]);
    expect(getConfiguredProviderCalls).toEqual([]);
  });
});
