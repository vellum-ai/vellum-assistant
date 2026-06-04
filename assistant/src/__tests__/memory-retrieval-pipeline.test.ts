/**
 * Tests for the `memoryRetrieval` plugin pipeline.
 *
 * Covers the default terminal behavior, the side effects the retriever owns
 * (injected-block metadata, recall log, `memory_recalled` event), timeout
 * handling, and custom-plugin substitution. Uses `mock.module` to stub the
 * workspace PKB/NOW readers and the persistence helpers so the test doesn't
 * touch the developer's real `~/.vellum` or database. The memory graph handle
 * is a hand-rolled fake passed as a dependency — the default retriever only
 * needs `prepareMemory`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub PKB/NOW readers and persistence helpers BEFORE importing the module
// under test so the bindings resolve through the mocks.
const readPkbContextMock = mock((): string | null => "pkb-default");
const readNowContextMock = mock((): string | null => "now-default");
mock.module("../daemon/conversation-runtime-assembly.js", () => ({
  readPkbContext: readPkbContextMock,
  readNowScratchpad: readNowContextMock,
}));

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
import type { TrustContext } from "../daemon/trust-context.js";
import type { ConversationGraphMemory } from "../memory/graph/conversation-graph-memory.js";
import {
  type DefaultMemoryRetrievalDeps,
  defaultMemoryRetrievalPlugin,
  runDefaultMemoryRetrieval,
} from "../plugins/defaults/memory-retrieval/register.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import {
  getMiddlewaresFor,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import {
  type MemoryArgs,
  type MemoryResult,
  type Middleware,
  type Plugin,
  PluginTimeoutError,
  type TurnContext,
} from "../plugins/types.js";
import type { Message } from "../providers/types.js";

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function makeTurnCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-test",
    conversationId: "conv-test",
    turnIndex: 0,
    trust,
    ...overrides,
  };
}

function makeMemoryArgs(overrides: Partial<MemoryArgs> = {}): MemoryArgs {
  return {
    conversationId: "conv-test",
    trustContext: trust,
    turnIndex: 0,
    signal: new AbortController().signal,
    ...overrides,
  };
}

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
 * Fake graph-memory whose `prepareMemory` returns a canonical result. The
 * default retriever threads this return value through `MemoryResult.graphResult`,
 * so tests can assert the result by comparing object identity.
 */
function makeFakeGraphMemory(overrides?: {
  messages?: Message[];
  injectedTokens?: number;
  injectedBlockText?: string | null;
  metrics?: ReturnType<typeof makeMetrics> | null;
}): {
  memory: ConversationGraphMemory;
  prepareMemoryMock: ReturnType<typeof mock>;
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
  };
  const prepareMemoryMock = mock(async () => returnValue);
  const memory = {
    prepareMemory: prepareMemoryMock,
  } as unknown as ConversationGraphMemory;
  return { memory, prepareMemoryMock };
}

function makeDeps(
  overrides: Partial<DefaultMemoryRetrievalDeps> = {},
): DefaultMemoryRetrievalDeps {
  const { memory } = makeFakeGraphMemory();
  return {
    messages: [],
    graphMemory: memory,
    config: {} as AssistantConfig,
    onEvent: () => {},
    isTrustedActor: true,
    conversationId: "conv-test",
    userMessageId: "msg-test",
    logger: {
      warn: () => {},
    } as unknown as DefaultMemoryRetrievalDeps["logger"],
    ...overrides,
  };
}

beforeEach(() => {
  resetPluginRegistryForTests();
  readPkbContextMock.mockReset();
  readNowContextMock.mockReset();
  updateMessageMetadataMock.mockReset();
  recordMemoryRecallLogMock.mockReset();
  readPkbContextMock.mockImplementation(() => "pkb-default");
  readNowContextMock.mockImplementation(() => "now-default");
});

describe("runDefaultMemoryRetrieval", () => {
  test("returns PKB, NOW, and the graph result when the actor is trusted", async () => {
    const { memory, prepareMemoryMock } = makeFakeGraphMemory();
    const deps = makeDeps({ graphMemory: memory, isTrustedActor: true });

    const result = await runDefaultMemoryRetrieval(makeMemoryArgs(), deps);

    expect(result.pkbContent).toBe("pkb-default");
    expect(result.nowContent).toBe("now-default");
    expect(prepareMemoryMock).toHaveBeenCalledTimes(1);
    // The default retriever forwards the graph-memory return value verbatim
    // under `graphResult` — consumers in the agent loop rely on that identity.
    expect(result.graphResult).not.toBeNull();
    expect(result.graphResult?.mode).toBe("none");
  });

  test("skips graph retrieval and side effects for untrusted actors", async () => {
    const { memory, prepareMemoryMock } = makeFakeGraphMemory();
    const deps = makeDeps({ graphMemory: memory, isTrustedActor: false });

    const result = await runDefaultMemoryRetrieval(makeMemoryArgs(), deps);

    expect(prepareMemoryMock).not.toHaveBeenCalled();
    expect(result.graphResult).toBeNull();
    expect(result.pkbContent).toBe("pkb-default");
    expect(result.nowContent).toBe("now-default");
    expect(recordMemoryRecallLogMock).not.toHaveBeenCalled();
    expect(updateMessageMetadataMock).not.toHaveBeenCalled();
  });

  test("persists injected block, recall log, and emits memory_recalled", async () => {
    const received: ServerMessage[] = [];
    const { memory } = makeFakeGraphMemory({
      injectedBlockText: "injected-block",
      metrics: makeMetrics(),
    });
    const deps = makeDeps({
      graphMemory: memory,
      onEvent: (msg) => received.push(msg),
      userMessageId: "msg-42",
      conversationId: "conv-42",
    });

    await runDefaultMemoryRetrieval(makeMemoryArgs(), deps);

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
    const deps = makeDeps({ graphMemory: memory });

    await runDefaultMemoryRetrieval(makeMemoryArgs(), deps);

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
    const deps = makeDeps({ graphMemory, isTrustedActor: true });

    await expect(
      runDefaultMemoryRetrieval(makeMemoryArgs(), deps),
    ).rejects.toThrow("retrieval failed");
  });

  test("passes through null PKB and NOW when the files are absent", async () => {
    readPkbContextMock.mockImplementation(() => null);
    readNowContextMock.mockImplementation(() => null);
    const deps = makeDeps();

    const result = await runDefaultMemoryRetrieval(makeMemoryArgs(), deps);

    expect(result.pkbContent).toBeNull();
    expect(result.nowContent).toBeNull();
  });
});

describe("memoryRetrieval pipeline — default vs custom plugin", () => {
  test("default (no plugins registered) matches current retrieval exactly", async () => {
    const deps = makeDeps();
    const args = makeMemoryArgs();
    const terminalDirect = await runDefaultMemoryRetrieval(args, deps);

    // With an empty registry the pipeline runs the terminal directly. Use a
    // fresh graph handle so `prepareMemory` call counts don't leak across
    // the two invocations.
    const deps2 = makeDeps();
    const terminalViaPipeline = await runPipeline(
      "memoryRetrieval",
      getMiddlewaresFor("memoryRetrieval"),
      (innerArgs: MemoryArgs) => runDefaultMemoryRetrieval(innerArgs, deps2),
      args,
      makeTurnCtx(),
      DEFAULT_TIMEOUTS.memoryRetrieval,
    );

    expect(terminalViaPipeline.pkbContent).toBe(terminalDirect.pkbContent);
    expect(terminalViaPipeline.nowContent).toBe(terminalDirect.nowContent);
    expect(terminalViaPipeline.graphResult).not.toBeNull();
    expect(terminalDirect.graphResult).not.toBeNull();
  });

  test("with the default plugin registered, pipeline still produces default output", async () => {
    registerPlugin(defaultMemoryRetrievalPlugin);
    const deps = makeDeps();
    const args = makeMemoryArgs();

    const result = await runPipeline(
      "memoryRetrieval",
      getMiddlewaresFor("memoryRetrieval"),
      (innerArgs: MemoryArgs) => runDefaultMemoryRetrieval(innerArgs, deps),
      args,
      makeTurnCtx(),
      DEFAULT_TIMEOUTS.memoryRetrieval,
    );

    expect(result.pkbContent).toBe("pkb-default");
    expect(result.nowContent).toBe("now-default");
    expect(result.graphResult).not.toBeNull();
  });

  test("custom plugin can replace all sources via short-circuit", async () => {
    const customMiddleware: Middleware<MemoryArgs, MemoryResult> =
      async function customRetriever() {
        // Skip `next` entirely — the terminal never runs.
        return {
          pkbContent: "pkb-custom",
          nowContent: "now-custom",
          graphResult: null,
        };
      };

    const customPlugin: Plugin = {
      manifest: {
        name: "custom-memory-retrieval",
        version: "0.0.1",
      },
      middleware: { memoryRetrieval: customMiddleware },
    };
    registerPlugin(customPlugin);

    const deps = makeDeps();
    const args = makeMemoryArgs();

    const result = await runPipeline(
      "memoryRetrieval",
      getMiddlewaresFor("memoryRetrieval"),
      (innerArgs: MemoryArgs) => runDefaultMemoryRetrieval(innerArgs, deps),
      args,
      makeTurnCtx(),
      DEFAULT_TIMEOUTS.memoryRetrieval,
    );

    expect(result.pkbContent).toBe("pkb-custom");
    expect(result.nowContent).toBe("now-custom");
    expect(result.graphResult).toBeNull();
    // The terminal never ran, so the stubbed readers were NOT invoked.
    expect(readPkbContextMock).not.toHaveBeenCalled();
    expect(readNowContextMock).not.toHaveBeenCalled();
  });

  test("timeout: terminal that hangs past the budget fails with PluginTimeoutError", async () => {
    // Hang-prone middleware that never resolves; the runner arms a 5s timer
    // by default, but the test overrides to a much smaller budget to keep
    // the suite fast.
    const hanging: Middleware<MemoryArgs, MemoryResult> =
      async function hangingRetriever(_args, _next) {
        return new Promise<MemoryResult>(() => {
          // Never resolves — simulates a retriever that blocks on I/O.
        });
      };

    const plugin: Plugin = {
      manifest: {
        name: "hanging-memory-plugin",
        version: "0.0.1",
      },
      middleware: { memoryRetrieval: hanging },
    };
    registerPlugin(plugin);

    const deps = makeDeps();
    const args = makeMemoryArgs();

    let caught: unknown;
    try {
      await runPipeline(
        "memoryRetrieval",
        getMiddlewaresFor("memoryRetrieval"),
        (innerArgs: MemoryArgs) => runDefaultMemoryRetrieval(innerArgs, deps),
        args,
        makeTurnCtx(),
        30, // tiny pipeline budget to keep the test fast
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PluginTimeoutError);
    const timeoutErr = caught as PluginTimeoutError;
    expect(timeoutErr.pipeline).toBe("memoryRetrieval");
    // The runner records whatever `ctx.pluginName` is set to when the
    // timer fires. The default pipeline doesn't bind a plugin name, so
    // the attribution is undefined — still fail the turn cleanly.
    expect(timeoutErr.message).toContain("memoryRetrieval");
  });

  test("pipeline timeout aborts the signal threaded into prepareMemory", async () => {
    // Verifies that the pipeline's abort-linker swaps `MemoryArgs.signal`
    // for a linked signal so a pipeline timeout aborts `prepareMemory`
    // and prevents graph-state mutation / event emission after the
    // pipeline has already errored.
    let capturedSignal: AbortSignal | undefined;
    const hangingPrepare = mock(
      (
        _msgs: Message[],
        _cfg: AssistantConfig,
        signal: AbortSignal,
        _onEvent: (msg: ServerMessage) => void,
      ) => {
        capturedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    );
    const graphMemory = {
      prepareMemory: hangingPrepare,
    } as unknown as ConversationGraphMemory;
    const deps = makeDeps({ graphMemory });
    const outerController = new AbortController();
    const args = makeMemoryArgs({ signal: outerController.signal });

    let caught: unknown;
    try {
      await runPipeline(
        "memoryRetrieval",
        getMiddlewaresFor("memoryRetrieval"),
        (innerArgs: MemoryArgs) => runDefaultMemoryRetrieval(innerArgs, deps),
        args,
        makeTurnCtx(),
        30,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PluginTimeoutError);
    expect(capturedSignal).toBeDefined();
    // The signal the terminal observed must be the pipeline's linked
    // signal (not the caller's bare signal), and it must be aborted so
    // `prepareMemory` stops work instead of running to completion after
    // the race has already rejected.
    expect(capturedSignal).not.toBe(outerController.signal);
    expect(capturedSignal!.aborted).toBe(true);
  });

  test("onEvent is forwarded into the default retriever's terminal path", async () => {
    const received: ServerMessage[] = [];
    const { memory } = makeFakeGraphMemory();
    const deps = makeDeps({
      graphMemory: memory,
      onEvent: (msg) => received.push(msg),
      isTrustedActor: true,
    });

    await runDefaultMemoryRetrieval(makeMemoryArgs(), deps);

    // The fake graph emits no events and reports no metrics, so no
    // `memory_recalled` event is produced — but the sink must be forwarded
    // intact so the real retriever can use it.
    expect(received).toEqual([]);
  });
});
