/**
 * Tests that the native Anthropic `server_tool_complete` agent event produces
 * a structured `WebSearchMetadata` payload on the emitted `tool_result` server
 * message while keeping the back-compat `result: string` byte-identical.
 *
 * Mirrors the mocked-dependency collector pattern used in
 * tool-result-metadata-plumbing.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock platform (must precede imports that read it) ─────────────────────────
mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    skills: {
      entries: {},
      load: { extraDirs: [], watch: false, watchDebounceMs: 0 },
      install: { nodeManager: "npm" },
      allowBundled: null,
      remoteProviders: {
        skillssh: { enabled: true },
        clawhub: { enabled: true },
      },
      remotePolicy: {
        blockSuspicious: true,
        blockMalware: true,
        maxSkillsShRisk: "medium",
      },
    },
  }),
  loadConfig: () => ({}),
}));

mock.module("../../memory/conversation-crud.js", () => ({
  addMessage: () => ({ id: "mock-msg-id" }),
  getMessageById: () => null,
  updateMessageContent: () => {},
  provenanceFromTrustContext: () => ({}),
}));

mock.module("../../memory/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  dispatchAgentEvent,
} from "../conversation-agent-loop-handlers.js";
import type { ServerMessage } from "../message-protocol.js";

type ToolResultEvent = Extract<ServerMessage, { type: "tool_result" }>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function createCollectorDeps(): {
  deps: EventHandlerDeps;
  events: ServerMessage[];
} {
  const events: ServerMessage[] = [];
  const deps = {
    ctx: {
      conversationId: "conv-native-meta",
      provider: { name: "anthropic" },
      traceEmitter: { emit: () => {} },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (msg: ServerMessage) => events.push(msg),
    reqId: "req-native-meta",
    isFirstMessage: false,
    shouldGenerateTitle: false,
    rlog: new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }) as unknown as EventHandlerDeps["rlog"],
    turnChannelContext: {
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
    } as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    } as EventHandlerDeps["turnInterfaceContext"],
  } as EventHandlerDeps;
  return { deps, events };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("native server_tool_complete metadata", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    state = createEventHandlerState();
  });

  test("builds structured WebSearchMetadata and keeps result text byte-identical", async () => {
    const { deps, events } = createCollectorDeps();
    const toolUseId = "tu1";

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_start",
      name: "web_search",
      toolUseId,
      input: { query: "Air Jordan auction" },
    });

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_complete",
      toolUseId,
      isError: false,
      content: [
        {
          type: "web_search_result",
          title: "X",
          url: "https://www.cnn.com/a",
        },
        {
          type: "web_search_result",
          title: "Y",
          url: "https://www.nbcnews.com/b",
        },
      ],
    });

    const toolResultEvent = events.find(
      (e): e is ToolResultEvent => e.type === "tool_result",
    );
    expect(toolResultEvent).toBeDefined();

    const meta = toolResultEvent?.activityMetadata?.webSearch;
    expect(meta).toBeDefined();
    expect(meta?.query).toBe("Air Jordan auction");
    expect(meta?.provider).toBe("anthropic-native");
    expect(meta?.resultCount).toBe(2);
    expect(meta?.results[0]?.domain).toBe("www.cnn.com");
    expect(meta?.results[1]?.domain).toBe("www.nbcnews.com");
    expect(meta?.results[0]?.rank).toBe(1);
    expect(meta?.results[1]?.rank).toBe(2);
    expect(meta?.durationMs).toBeGreaterThanOrEqual(0);

    // Back-compat: result text must be byte-identical to the legacy format.
    expect(toolResultEvent?.result).toBe(
      "X\nhttps://www.cnn.com/a\n\nY\nhttps://www.nbcnews.com/b",
    );

    // Per-toolUseId scratch maps must be cleaned up after completion.
    expect(state.serverToolStartedAt.has(toolUseId)).toBe(false);
    expect(state.serverToolInputs.has(toolUseId)).toBe(false);
  });

  test("sets errorMessage when the search errored", async () => {
    const { deps, events } = createCollectorDeps();
    const toolUseId = "tu_err";

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_start",
      name: "web_search",
      toolUseId,
      input: { query: "broken" },
    });

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_complete",
      toolUseId,
      isError: true,
      content: [],
    });

    const toolResultEvent = events.find(
      (e): e is ToolResultEvent => e.type === "tool_result",
    );
    const meta = toolResultEvent?.activityMetadata?.webSearch;
    expect(meta?.errorMessage).toBe("Search failed");
    expect(meta?.resultCount).toBe(0);
    expect(meta?.results).toEqual([]);
    expect(toolResultEvent?.isError).toBe(true);
  });
});
