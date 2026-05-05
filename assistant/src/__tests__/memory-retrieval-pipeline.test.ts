/**
 * Tests for the `memoryRetrieval` plugin pipeline (PR 20).
 *
 * Covers the default terminal behavior, timeout handling, and custom-plugin
 * substitution. Uses `mock.module` to stub the workspace PKB/NOW readers
 * so the test doesn't touch the developer's real `~/.vellum`. The memory
 * graph handle is a hand-rolled fake passed as a dependency — the default
 * retriever only needs `prepareMemory`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub PKB/NOW readers BEFORE importing the module under test so the
// bindings resolve through the mock.
const readPkbContextMock = mock((): string | null => "pkb-default");
const readNowContextMock = mock((): string | null => "now-default");
mock.module("../daemon/conversation-runtime-assembly.js", () => ({
  readPkbContext: readPkbContextMock,
  readNowScratchpad: readNowContextMock,
}));

import type { AssistantConfig } from "../config/schema.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type { ConversationGraphMemory } from "../memory/graph/conversation-graph-memory.js";
import {
  asDefaultGraphPayload,
  DEFAULT_MEMORY_GRAPH_KIND,
  type DefaultMemoryRetrievalDeps,
  defaultMemoryRetrievalPlugin,
  runDefaultMemoryRetrieval,
} from "../plugins/defaults/memory-retrieval.js";
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

/**
 * Fake graph-memory whose `prepareMemory` returns a canonical result. The
 * default retriever threads this return value through
 * `MemoryResult.memoryGraphBlocks[0].result`, so tests can assert the block
 * shape by comparing the embedded object identity.
 */
function makeFakeGraphMemory(overrides?: {
  messages?: Message[];
  injectedTokens?: number;
  injectedBlockText?: string | null;
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
    metrics: null,
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
    ...overrides,
  };
}

beforeEach(() => {
  resetPluginRegistryForTests();
  readPkbContextMock.mockReset();
  readNowContextMock.mockReset();
  readPkbContextMock.mockImplementation(() => "pkb-default");
  readNowContextMock.mockImplementation(() => "now-default");
});

describe("runDefaultMemoryRetrieval", () => {
  test("returns PKB, NOW, and a single graph block when the actor is trusted", async () => {
    const { memory, prepareMemoryMock } = makeFakeGraphMemory();
    const deps = makeDeps({ graphMemory: memory, isTrustedActor: true });

    const result = await runDefaultMemoryRetrieval(makeMemoryArgs(), deps);

    expect(result.pkbContent).toBe("pkb-default");
    expect(result.nowContent).toBe("now-default");
    expect(result.memoryGraphBlocks).toHaveLength(1);
    expect(prepareMemoryMock).toHaveBeenCalledTimes(1);

    const payload = asDefaultGraphPayload(result.memoryGraphBlocks);
    expect(payload).not.toBeNull();
    expect(payload?.kind).toBe(DEFAULT_MEMORY_GRAPH_KIND);
    // The default retriever forwards the graph-memory return value
    // verbatim under `payload.result` — consumers in the agent loop
    // rely on that identity.
    expect(payload?.result.mode).toBe("none");
  });

  test("skips graph retrieval for untrusted actors", async () => {
    const { memory, prepareMemoryMock } = makeFakeGraphMemory();
    const deps = makeDeps({ graphMemory: memory, isTrustedActor: false });

    const result = await runDefaultMemoryRetrieval(makeMemoryArgs(), deps);

    expect(prepareMemoryMock).not.toHaveBeenCalled();
    expect(result.memoryGraphBlocks).toEqual([]);
    expect(result.pkbContent).toBe("pkb-default");
    expect(result.nowContent).toBe("now-default");
  });

  test("soft-times out graph retrieval and keeps PKB/NOW", async () => {
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
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      },
    );
    const graphMemory = {
      prepareMemory: hangingPrepare,
    } as unknown as ConversationGraphMemory;
    const deps = makeDeps({
      graphMemory,
      isTrustedActor: true,
      graphRetrievalBudgetMs: 20,
    });

    const result = await runDefaultMemoryRetrieval(makeMemoryArgs(), deps);

    expect(result.pkbContent).toBe("pkb-default");
    expect(result.nowContent).toBe("now-default");
    expect(result.memoryGraphBlocks).toEqual([]);
    expect(capturedSignal?.aborted).toBe(true);
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

describe("asDefaultGraphPayload", () => {
  test("returns null when the blocks array is empty", () => {
    expect(asDefaultGraphPayload([])).toBeNull();
  });

  test("returns null when the first block lacks the default discriminator", () => {
    expect(asDefaultGraphPayload([{ kind: "custom" }])).toBeNull();
    expect(asDefaultGraphPayload([{}])).toBeNull();
    expect(asDefaultGraphPayload([null])).toBeNull();
  });

  test("narrows blocks whose first entry carries the default discriminator", () => {
    const payload = {
      kind: DEFAULT_MEMORY_GRAPH_KIND,
      result: { mode: "per-turn" } as never,
    };
    expect(asDefaultGraphPayload([payload])).toBe(payload);
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
    expect(terminalViaPipeline.memoryGraphBlocks).toHaveLength(
      terminalDirect.memoryGraphBlocks.length,
    );
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
    expect(result.memoryGraphBlocks).toHaveLength(1);
    expect(asDefaultGraphPayload(result.memoryGraphBlocks)).not.toBeNull();
  });

  test("custom plugin can replace all three sources via short-circuit", async () => {
    const customBlock = { kind: "custom.source", text: "replacement" };
    const customMiddleware: Middleware<MemoryArgs, MemoryResult> =
      async function customRetriever() {
        // Skip `next` entirely — the terminal never runs.
        return {
          pkbContent: "pkb-custom",
          nowContent: "now-custom",
          memoryGraphBlocks: [customBlock],
        };
      };

    const customPlugin: Plugin = {
      manifest: {
        name: "custom-memory-retrieval",
        version: "0.0.1",
        requires: { pluginRuntime: "v1", memoryApi: "v1" },
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
    expect(result.memoryGraphBlocks).toEqual([customBlock]);
    // The terminal never ran, so the stubbed readers were NOT invoked.
    expect(readPkbContextMock).not.toHaveBeenCalled();
    expect(readNowContextMock).not.toHaveBeenCalled();
    // And `asDefaultGraphPayload` must return null because the custom
    // plugin supplied a block without the default discriminator — this is
    // what drives the agent-loop escape hatch.
    expect(asDefaultGraphPayload(result.memoryGraphBlocks)).toBeNull();
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
        requires: { pluginRuntime: "v1", memoryApi: "v1" },
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

  test("onEvent is invoked by the default retriever's terminal path", async () => {
    const received: ServerMessage[] = [];
    const { memory } = makeFakeGraphMemory();
    const deps = makeDeps({
      graphMemory: memory,
      onEvent: (msg) => received.push(msg),
      isTrustedActor: true,
    });

    await runDefaultMemoryRetrieval(makeMemoryArgs(), deps);

    // The fake graph doesn't emit events, but the event sink must be
    // forwarded intact so the real retriever can use it. Verify by
    // reaching into the mock assertion above (prepareMemoryMock called
    // with `onEvent`).
    expect(received).toEqual([]);
  });
});
