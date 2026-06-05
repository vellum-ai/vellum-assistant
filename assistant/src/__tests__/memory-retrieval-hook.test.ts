/**
 * Tests for the default `user-prompt-submit-temp` hook (memory retrieval).
 *
 * Covers the retrieval behavior, the side effects the hook owns (injected-block
 * metadata, recall log, `memory_recalled` event), trust gating, error
 * propagation, and abort-signal forwarding. Uses `mock.module` to stub the
 * persistence helpers so the test doesn't touch the developer's real
 * `~/.vellum` or database. The memory graph handle is a hand-rolled fake
 * passed on the hook context — the hook only needs `prepareMemory`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the persistence helpers BEFORE importing the module under test so the
// bindings resolve through the mocks.
const updateMessageMetadataMock = mock((_id: string, _updates: unknown) => {});
mock.module("../memory/conversation-crud.js", () => ({
  updateMessageMetadata: updateMessageMetadataMock,
}));

const recordMemoryRecallLogMock = mock((_entry: unknown) => {});
mock.module("../memory/memory-recall-log-store.js", () => ({
  recordMemoryRecallLog: recordMemoryRecallLogMock,
}));

import type { AssistantConfig } from "../config/schema.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { ConversationGraphMemory } from "../memory/graph/conversation-graph-memory.js";
import type { QdrantSparseVector } from "../memory/qdrant-client.js";
import userPromptSubmitMemoryRetrieval, {
  type MemoryRetrievalHookContext,
} from "../plugins/defaults/memory-retrieval/hooks/user-prompt-submit-temp.js";
import type { Message } from "../providers/types.js";

/** Canonical metrics payload the graph retriever attaches to a real hit. */
function makeMetrics() {
  return {
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    semanticHits: 2,
    mergedCount: 3,
    selectedCount: 1,
    tier1Count: 1,
    tier2Count: 0,
    hybridSearchLatencyMs: 5,
    sparseVectorUsed: true,
    topCandidates: [
      {
        nodeId: "node-1",
        type: "fact",
        score: 0.9,
        semanticSimilarity: 0.8,
        recencyBoost: 0.1,
      },
    ],
    queryContext: "query-context",
  };
}

/**
 * Fake graph-memory whose `prepareMemory` returns a canonical result. The hook
 * unpacks this return value onto `ctx.latestMessages` and records the selected
 * PKB query pair back onto the handle via `recordPkbQueryVectors`, so tests
 * can assert those outputs by comparing object identity.
 */
function makeFakeGraphMemory(overrides?: {
  messages?: Message[];
  injectedTokens?: number;
  injectedBlockText?: string | null;
  metrics?: ReturnType<typeof makeMetrics> | null;
  queryVector?: number[];
  sparseVector?: QdrantSparseVector;
  userQueryVector?: number[];
  userQuerySparseVector?: QdrantSparseVector;
}): {
  memory: ConversationGraphMemory;
  prepareMemoryMock: ReturnType<typeof mock>;
  recordPkbQueryVectorsMock: ReturnType<typeof mock>;
} {
  const returnValue = {
    runMessages: overrides?.messages ?? [],
    injectedTokens: overrides?.injectedTokens ?? 0,
    latencyMs: 0,
    mode: "none" as const,
    injectedBlockText:
      overrides?.injectedBlockText === undefined
        ? null
        : overrides.injectedBlockText,
    metrics: overrides?.metrics ?? null,
    queryVector: overrides?.queryVector,
    sparseVector: overrides?.sparseVector,
    userQueryVector: overrides?.userQueryVector,
    userQuerySparseVector: overrides?.userQuerySparseVector,
  };
  const prepareMemoryMock = mock(async () => returnValue);
  const recordPkbQueryVectorsMock = mock(() => {});
  const memory = {
    prepareMemory: prepareMemoryMock,
    recordPkbQueryVectors: recordPkbQueryVectorsMock,
  } as unknown as ConversationGraphMemory;
  return { memory, prepareMemoryMock, recordPkbQueryVectorsMock };
}

function makeHookCtx(
  overrides: Partial<MemoryRetrievalHookContext> = {},
): MemoryRetrievalHookContext {
  const { memory } = makeFakeGraphMemory();
  return {
    graphMemory: memory,
    config: {} as AssistantConfig,
    onEvent: () => {},
    isTrustedActor: true,
    conversationId: "conv-test",
    userMessageId: "msg-test",
    logger: {
      warn: () => {},
    } as unknown as MemoryRetrievalHookContext["logger"],
    signal: new AbortController().signal,
    latestMessages: [],
    ...overrides,
  };
}

beforeEach(() => {
  updateMessageMetadataMock.mockReset();
  recordMemoryRecallLogMock.mockReset();
});

describe("user-prompt-submit-temp hook (memory retrieval)", () => {
  test("adopts the injected run messages when the actor is trusted", async () => {
    const injected: Message[] = [
      { role: "user", content: [{ type: "text", text: "injected" }] },
    ];
    const { memory, prepareMemoryMock } = makeFakeGraphMemory({
      messages: injected,
    });
    const ctx = makeHookCtx({ graphMemory: memory, isTrustedActor: true });

    await userPromptSubmitMemoryRetrieval(ctx);

    expect(prepareMemoryMock).toHaveBeenCalledTimes(1);
    // The hook adopts the retriever's injected message array verbatim —
    // consumers in the agent loop rely on that identity.
    expect(ctx.latestMessages).toBe(injected);
  });

  test("selects the user-query dense/sparse pair when present, else the summary pair", async () => {
    const userDense = [1, 1, 1];
    const userSparse: QdrantSparseVector = { indices: [0], values: [1] };
    const summaryDense = [2, 2, 2];
    const summarySparse: QdrantSparseVector = { indices: [1], values: [2] };

    const withUserQuery = makeFakeGraphMemory({
      queryVector: summaryDense,
      sparseVector: summarySparse,
      userQueryVector: userDense,
      userQuerySparseVector: userSparse,
    });
    const userCtx = makeHookCtx({ graphMemory: withUserQuery.memory });
    await userPromptSubmitMemoryRetrieval(userCtx);
    // User-query pair wins — never crossed with the summary signal — and is
    // recorded back onto the graph handle for the PKB-reminder injector.
    expect(withUserQuery.recordPkbQueryVectorsMock).toHaveBeenCalledWith(
      userDense,
      userSparse,
    );

    const summaryOnly = makeFakeGraphMemory({
      queryVector: summaryDense,
      sparseVector: summarySparse,
    });
    const summaryCtx = makeHookCtx({ graphMemory: summaryOnly.memory });
    await userPromptSubmitMemoryRetrieval(summaryCtx);
    expect(summaryOnly.recordPkbQueryVectorsMock).toHaveBeenCalledWith(
      summaryDense,
      summarySparse,
    );
  });

  test("skips graph retrieval and side effects for untrusted actors", async () => {
    const { memory, prepareMemoryMock, recordPkbQueryVectorsMock } =
      makeFakeGraphMemory();
    const seeded: Message[] = [
      { role: "user", content: [{ type: "text", text: "seeded" }] },
    ];
    const ctx = makeHookCtx({
      graphMemory: memory,
      isTrustedActor: false,
      latestMessages: seeded,
    });

    await userPromptSubmitMemoryRetrieval(ctx);

    expect(prepareMemoryMock).not.toHaveBeenCalled();
    // No graph retrieval ran: the working array stays the seeded input and no
    // PKB query pair is recorded onto the graph handle.
    expect(ctx.latestMessages).toBe(seeded);
    expect(recordPkbQueryVectorsMock).not.toHaveBeenCalled();
    expect(recordMemoryRecallLogMock).not.toHaveBeenCalled();
    expect(updateMessageMetadataMock).not.toHaveBeenCalled();
  });

  test("persists injected block, recall log, and emits memory_recalled", async () => {
    const received: ServerMessage[] = [];
    const { memory } = makeFakeGraphMemory({
      injectedBlockText: "injected-block",
      metrics: makeMetrics(),
    });
    const ctx = makeHookCtx({
      graphMemory: memory,
      onEvent: (msg) => received.push(msg),
      userMessageId: "msg-42",
      conversationId: "conv-42",
    });

    await userPromptSubmitMemoryRetrieval(ctx);

    expect(updateMessageMetadataMock).toHaveBeenCalledWith("msg-42", {
      memoryInjectedBlock: "injected-block",
    });
    expect(recordMemoryRecallLogMock).toHaveBeenCalledTimes(1);
    const logEntry = recordMemoryRecallLogMock.mock.calls[0]?.[0] as {
      conversationId: string;
      reason: string;
    };
    expect(logEntry.conversationId).toBe("conv-42");
    expect(logEntry.reason).toBe("graph:none");
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("memory_recalled");
  });

  test("skips metadata persist when no block text is injected", async () => {
    const { memory } = makeFakeGraphMemory({ injectedBlockText: null });
    const ctx = makeHookCtx({ graphMemory: memory });

    await userPromptSubmitMemoryRetrieval(ctx);

    expect(updateMessageMetadataMock).not.toHaveBeenCalled();
    // The recall log is still written even without an injected block.
    expect(recordMemoryRecallLogMock).toHaveBeenCalledTimes(1);
  });

  test("propagates errors from prepareMemory rather than swallowing them", async () => {
    // Memory is critical — failures must surface to the caller (the agent
    // loop) rather than silently degrading to an empty graph result.
    const failingPrepare = mock(
      (
        _msgs: Message[],
        _cfg: AssistantConfig,
        _signal: AbortSignal,
        _onEvent: (msg: ServerMessage) => void,
      ) => Promise.reject(new Error("retrieval failed")),
    );
    const graphMemory = {
      prepareMemory: failingPrepare,
    } as unknown as ConversationGraphMemory;
    const ctx = makeHookCtx({ graphMemory, isTrustedActor: true });

    await expect(userPromptSubmitMemoryRetrieval(ctx)).rejects.toThrow(
      "retrieval failed",
    );
  });

  test("forwards the context abort signal into prepareMemory", async () => {
    // The hook hands its `ctx.signal` straight to `prepareMemory` so an
    // external cancel aborts the underlying retrieval.
    let capturedSignal: AbortSignal | undefined;
    const prepareMemoryMock = mock(
      async (
        _msgs: Message[],
        _cfg: AssistantConfig,
        signal: AbortSignal,
        _onEvent: (msg: ServerMessage) => void,
      ) => {
        capturedSignal = signal;
        return {
          runMessages: [],
          injectedTokens: 0,
          latencyMs: 0,
          mode: "none" as const,
          injectedBlockText: null,
          metrics: null,
        };
      },
    );
    const graphMemory = {
      prepareMemory: prepareMemoryMock,
      recordPkbQueryVectors: mock(() => {}),
    } as unknown as ConversationGraphMemory;
    const controller = new AbortController();
    const ctx = makeHookCtx({ graphMemory, signal: controller.signal });

    await userPromptSubmitMemoryRetrieval(ctx);

    expect(capturedSignal).toBe(controller.signal);
  });
});
