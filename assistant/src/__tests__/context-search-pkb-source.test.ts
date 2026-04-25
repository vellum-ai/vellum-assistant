import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../config/schema.js";
import type { RecallSearchContext } from "../memory/context-search/types.js";
import { PKB_WORKSPACE_SCOPE } from "../memory/pkb/types.js";
import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

const embedCalls: Array<{
  config: AssistantConfig;
  texts: unknown[];
  opts?: { signal?: AbortSignal };
}> = [];
let embedVectors: number[][] = [[0.1, 0.2, 0.3]];
let embedThrows: Error | null = null;

mock.module("../memory/embed.js", () => ({
  embedWithRetry: async (
    config: AssistantConfig,
    texts: unknown[],
    opts?: { signal?: AbortSignal },
  ) => {
    embedCalls.push({ config, texts, opts });
    if (embedThrows) throw embedThrows;
    return { vectors: embedVectors, provider: "test", model: "test-model" };
  },
}));

const sparseCalls: string[] = [];
let sparseVector = { indices: [1], values: [1] };

mock.module("../memory/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
  embedWithBackend: async () => ({
    vectors: [],
    provider: "test",
    model: "test-model",
  }),
  generateSparseEmbedding: (text: string) => {
    sparseCalls.push(text);
    return sparseVector;
  },
  getMemoryBackendStatus: async () => ({
    provider: "test",
    model: "test-model",
    available: true,
  }),
  logMemoryEmbeddingWarning: () => {},
  resetLocalEmbeddingFailureState: () => {},
  selectEmbeddingBackend: async () => ({
    backend: {
      provider: "test",
      model: "test-model",
      embed: async () => [],
    },
    provider: "test",
    model: "test-model",
  }),
  selectedBackendSupportsMultimodal: async () => false,
  SPARSE_EMBEDDING_VERSION: 2,
}));

type ScoredPoint = {
  id: string;
  score: number;
  payload: {
    target_type: "pkb_file";
    target_id: string;
    path: string;
    text?: string;
  };
};

const qdrantSearchCalls: Array<{
  vector: number[];
  limit: number;
  filter?: unknown;
}> = [];
const hybridSearchCalls: Array<{
  denseVector: number[];
  sparseVector: { indices: number[]; values: number[] };
  filter?: unknown;
  limit: number;
  prefetchLimit?: number;
}> = [];
let denseResults: ScoredPoint[] = [];
let hybridResults: ScoredPoint[] = [];
let denseThrows: Error | null = null;

mock.module("../memory/qdrant-circuit-breaker.js", () => ({
  QdrantCircuitOpenError: class extends Error {},
  _resetQdrantBreaker: () => {},
  isQdrantBreakerOpen: () => false,
  shouldAllowQdrantProbe: () => true,
  withQdrantBreaker: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    search: async (
      vector: number[],
      limit: number,
      filter?: Record<string, unknown>,
    ) => {
      qdrantSearchCalls.push({ vector, limit, filter });
      if (denseThrows) throw denseThrows;
      return denseResults;
    },
    hybridSearch: async (params: {
      denseVector: number[];
      sparseVector: { indices: number[]; values: number[] };
      filter?: unknown;
      limit: number;
      prefetchLimit?: number;
    }) => {
      hybridSearchCalls.push(params);
      return hybridResults;
    },
  }),
  initQdrantClient: () => {},
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
  VellumQdrantClient: class {},
}));

let pkbContext: string | null = null;
let nowScratchpad: string | null = null;

mock.module("../daemon/conversation-runtime-assembly.js", () => ({
  readPkbContext: () => pkbContext,
  readNowScratchpad: () => nowScratchpad,
}));

const { readPkbContextEvidence, searchPkbSource } =
  await import("../memory/context-search/sources/pkb.js");

function makeContext(signal?: AbortSignal): RecallSearchContext {
  return {
    workingDir: "/workspace",
    memoryScopeId: "active-conversation-scope",
    conversationId: "conv-xyz",
    config: {} as AssistantConfig,
    ...(signal ? { signal } : {}),
  };
}

describe("PKB context-search source", () => {
  beforeEach(() => {
    embedCalls.length = 0;
    embedVectors = [[0.1, 0.2, 0.3]];
    embedThrows = null;
    sparseCalls.length = 0;
    sparseVector = { indices: [1], values: [1] };
    qdrantSearchCalls.length = 0;
    hybridSearchCalls.length = 0;
    denseResults = [];
    hybridResults = [];
    denseThrows = null;
    pkbContext = null;
    nowScratchpad = null;
  });

  test("converts PKB hits to recall evidence with snippets and scores", async () => {
    denseResults = [
      {
        id: "dense-a",
        score: 0.82,
        payload: {
          target_type: "pkb_file",
          target_id: "a",
          path: "notes/project.md",
          text: "Dense project notes.",
        },
      },
      {
        id: "dense-b",
        score: 0.71,
        payload: {
          target_type: "pkb_file",
          target_id: "b",
          path: "notes/fallback.md",
        },
      },
    ];
    hybridResults = [
      {
        id: "hybrid-a",
        score: 0.04,
        payload: {
          target_type: "pkb_file",
          target_id: "a",
          path: "notes/project.md",
          text: "Project notes mention the launch checklist.",
        },
      },
    ];

    const result = await searchPkbSource("launch checklist", makeContext(), 2);

    expect(embedCalls[0]?.texts).toEqual(["launch checklist"]);
    expect(sparseCalls).toEqual(["launch checklist"]);
    expect(result.evidence).toEqual([
      {
        id: "pkb:notes/project.md:0",
        source: "pkb",
        title: "notes/project.md",
        locator: "notes/project.md",
        excerpt: "Project notes mention the launch checklist.",
        score: 0.04,
        metadata: {
          path: "notes/project.md",
          denseScore: 0.82,
          hybridScore: 0.04,
        },
      },
      {
        id: "pkb:notes/fallback.md:1",
        source: "pkb",
        title: "notes/fallback.md",
        locator: "notes/fallback.md",
        excerpt: "notes/fallback.md",
        score: 0.71,
        metadata: {
          path: "notes/fallback.md",
          denseScore: 0.71,
        },
      },
    ]);
  });

  test("uses the PKB workspace sentinel scope instead of the active context scope", async () => {
    denseResults = [
      {
        id: "a",
        score: 0.8,
        payload: {
          target_type: "pkb_file",
          target_id: "a",
          path: "notes/a.md",
        },
      },
    ];

    await searchPkbSource("notes", makeContext(), 5);

    expect(qdrantSearchCalls).toHaveLength(1);
    const filter = qdrantSearchCalls[0]?.filter as {
      must: Array<Record<string, unknown>>;
    };
    const scopeClause = filter.must.find(
      (clause) => clause.key === "memory_scope_id",
    ) as { match: { any: string[] } } | undefined;
    expect(scopeClause?.match.any).toEqual([PKB_WORKSPACE_SCOPE]);
    expect(scopeClause?.match.any).not.toContain("active-conversation-scope");
  });

  test("returns empty evidence when embedding has no vector", async () => {
    embedVectors = [];

    const result = await searchPkbSource("notes", makeContext(), 5);

    expect(result).toEqual({ evidence: [] });
    expect(qdrantSearchCalls).toHaveLength(0);
  });

  test("falls back to empty evidence when PKB search fails", async () => {
    denseThrows = new Error("qdrant unavailable");

    const result = await searchPkbSource("notes", makeContext(), 5);

    expect(result).toEqual({ evidence: [] });
  });

  test("returns no static PKB evidence when injected context is missing", () => {
    expect(readPkbContextEvidence(makeContext())).toEqual([]);
  });

  test("returns PKB auto-inject and NOW evidence when present", () => {
    pkbContext = "Always include the product glossary.";
    nowScratchpad = "Current priority: finish the launch checklist.";

    const evidence = readPkbContextEvidence(makeContext());

    expect(evidence).toEqual([
      {
        id: "pkb:auto-inject",
        source: "pkb",
        title: "PKB auto-injected context",
        locator: "pkb:auto-inject",
        excerpt: "Always include the product glossary.",
        metadata: { kind: "auto-inject" },
      },
      {
        id: "pkb:NOW.md",
        source: "pkb",
        title: "NOW.md",
        locator: "NOW.md",
        excerpt: "Current priority: finish the launch checklist.",
        metadata: { kind: "now" },
      },
    ]);
  });
});
