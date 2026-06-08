/**
 * Tests for the default `user-prompt-submit-temp` hook (memory retrieval +
 * runtime injection).
 *
 * Covers the retrieval behavior, the side effects the hook owns (injected-block
 * metadata, recall log, `memory_recalled` event), trust gating, the runtime
 * injection the hook applies for every actor (and the assembled-block persist),
 * error propagation, and abort-signal forwarding. Uses `mock.module` to stub
 * the persistence helpers, `applyRuntimeInjections`, and the conversation
 * registry / trust resolver so the test doesn't touch the developer's real
 * `~/.vellum`, database, or live conversation state. The memory graph handle,
 * abort signal, and trust class are self-resolved by the hook from a fake
 * conversation installed in the registry mock.
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

// Pass-through injection stub: returns the input messages unchanged with no
// assembled blocks, so existing array-identity assertions hold. Individual
// tests override it via `mockImplementationOnce` to exercise injected blocks.
const applyRuntimeInjectionsMock = mock(async (messages: unknown) => ({
  messages,
  blocks: {},
}));
mock.module("../daemon/conversation-runtime-assembly.js", () => ({
  applyRuntimeInjections: applyRuntimeInjectionsMock,
}));

// The hook self-resolves the live conversation and its trust class; both are
// driven from these refs so each test controls what the hook sees.
let currentConversation: Conversation | undefined;
let currentTrustClass: "guardian" | "unknown" = "guardian";
const findConversationOrSubagentMock = mock(
  (_conversationId?: string) => currentConversation,
);
mock.module("../daemon/conversation-registry.js", () => ({
  findConversationOrSubagent: findConversationOrSubagentMock,
}));
mock.module("../daemon/trust-context.js", () => ({
  resolveTrustClass: () => currentTrustClass,
}));
mock.module("../config/loader.js", () => ({
  getConfig: () => ({}) as AssistantConfig,
}));

import type { AssistantConfig } from "../config/schema.js";
import type { Conversation } from "../daemon/conversation.js";
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
  return {
    onEvent: () => {},
    conversationId: "conv-test",
    userMessageId: "msg-test",
    logger: {
      warn: () => {},
    } as unknown as MemoryRetrievalHookContext["logger"],
    latestMessages: [],
    requestId: "req-test",
    mode: "full",
    isNonInteractive: false,
    modelProfile: null,
    actorContext: null,
    ...overrides,
  };
}

/**
 * Install a fake live conversation for the hook to self-resolve by id: the
 * graph handle, abort signal, and trust class all come from here rather than
 * the hook context.
 */
function installConversation(
  graphMemory: ConversationGraphMemory,
  opts?: { trusted?: boolean; signal?: AbortSignal },
): void {
  currentTrustClass = opts?.trusted === false ? "unknown" : "guardian";
  currentConversation = {
    graphMemory,
    trustContext: undefined,
    abortController: { signal: opts?.signal ?? new AbortController().signal },
  } as unknown as Conversation;
}

beforeEach(() => {
  updateMessageMetadataMock.mockReset();
  recordMemoryRecallLogMock.mockReset();
  applyRuntimeInjectionsMock.mockClear();
  findConversationOrSubagentMock.mockClear();
  currentConversation = undefined;
  currentTrustClass = "guardian";
});

describe("user-prompt-submit-temp hook (memory retrieval)", () => {
  test("adopts the injected run messages when the actor is trusted", async () => {
    const injected: Message[] = [
      { role: "user", content: [{ type: "text", text: "injected" }] },
    ];
    const { memory, prepareMemoryMock } = makeFakeGraphMemory({
      messages: injected,
    });
    installConversation(memory, { trusted: true });
    const ctx = makeHookCtx();

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
    installConversation(withUserQuery.memory, { trusted: true });
    const userCtx = makeHookCtx();
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
    installConversation(summaryOnly.memory, { trusted: true });
    const summaryCtx = makeHookCtx();
    await userPromptSubmitMemoryRetrieval(summaryCtx);
    expect(summaryOnly.recordPkbQueryVectorsMock).toHaveBeenCalledWith(
      summaryDense,
      summarySparse,
    );
  });

  test("applies runtime injection on the retrieved history and persists the assembled blocks", async () => {
    const retrieved: Message[] = [
      { role: "user", content: [{ type: "text", text: "retrieved" }] },
    ];
    const injected: Message[] = [
      { role: "user", content: [{ type: "text", text: "injected" }] },
    ];
    const { memory } = makeFakeGraphMemory({ messages: retrieved });
    applyRuntimeInjectionsMock.mockImplementationOnce(async () => ({
      messages: injected,
      blocks: { unifiedTurnContext: "tc-block" },
    }));
    installConversation(memory, { trusted: true });
    const ctx = makeHookCtx({ userMessageId: "msg-77" });

    await userPromptSubmitMemoryRetrieval(ctx);

    // Injection runs on the retrieved history; its result becomes the working
    // list the loop reads back.
    expect(applyRuntimeInjectionsMock).toHaveBeenCalledTimes(1);
    expect(applyRuntimeInjectionsMock.mock.calls[0]?.[0]).toBe(retrieved);
    expect(ctx.latestMessages).toBe(injected);
    // The assembled blocks are persisted onto the user message metadata.
    expect(updateMessageMetadataMock).toHaveBeenCalledWith("msg-77", {
      turnContextBlock: "tc-block",
    });
  });

  test("applies runtime injection for untrusted actors despite skipping retrieval", async () => {
    const { memory, prepareMemoryMock } = makeFakeGraphMemory();
    const seeded: Message[] = [
      { role: "user", content: [{ type: "text", text: "seeded" }] },
    ];
    installConversation(memory, { trusted: false });
    const ctx = makeHookCtx({ latestMessages: seeded });

    await userPromptSubmitMemoryRetrieval(ctx);

    // The memory-graph step is gated on trust, but injection runs for everyone
    // — on the seeded history, since no retrieval replaced it.
    expect(prepareMemoryMock).not.toHaveBeenCalled();
    expect(applyRuntimeInjectionsMock).toHaveBeenCalledTimes(1);
    expect(applyRuntimeInjectionsMock.mock.calls[0]?.[0]).toBe(seeded);
  });

  test("skips graph retrieval and side effects for untrusted actors", async () => {
    const { memory, prepareMemoryMock, recordPkbQueryVectorsMock } =
      makeFakeGraphMemory();
    const seeded: Message[] = [
      { role: "user", content: [{ type: "text", text: "seeded" }] },
    ];
    installConversation(memory, { trusted: false });
    const ctx = makeHookCtx({ latestMessages: seeded });

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
    installConversation(memory, { trusted: true });
    const ctx = makeHookCtx({
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
    installConversation(memory, { trusted: true });
    const ctx = makeHookCtx();

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
    installConversation(graphMemory, { trusted: true });
    const ctx = makeHookCtx();

    await expect(userPromptSubmitMemoryRetrieval(ctx)).rejects.toThrow(
      "retrieval failed",
    );
  });

  test("forwards the conversation abort signal into prepareMemory", async () => {
    // The hook hands the live conversation's abort signal straight to
    // `prepareMemory` so an external cancel aborts the underlying retrieval.
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
    installConversation(graphMemory, {
      trusted: true,
      signal: controller.signal,
    });
    const ctx = makeHookCtx();

    await userPromptSubmitMemoryRetrieval(ctx);

    expect(capturedSignal).toBe(controller.signal);
  });
});
