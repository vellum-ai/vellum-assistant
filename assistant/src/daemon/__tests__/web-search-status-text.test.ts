/**
 * Tests that the in-flight activity status text emitted for `web_search`
 * and `web_fetch` tool starts surfaces per-call detail (the query / domain)
 * instead of a generic placeholder. Covers both the Anthropic native
 * `server_tool_start` path and the non-native `tool_use` path.
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

mock.module("../../persistence/conversation-crud.js", () => ({
  addMessage: () => ({ id: "mock-msg-id" }),
  getMessageById: () => null,
  updateMessageContent: () => {},
  provenanceFromTrustContext: () => ({}),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../../persistence/llm-request-log-store.js", () => ({
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
  formatFetchStatusText,
  formatSearchStatusText,
} from "../conversation-agent-loop-handlers.js";
import type { ServerMessage } from "../message-protocol.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ActivityStateCapture {
  phase: string;
  reason: string;
  anchor?: string;
  requestId?: string;
  statusText?: string;
}

function createCollectorDeps(): {
  deps: EventHandlerDeps;
  activityStates: ActivityStateCapture[];
} {
  const activityStates: ActivityStateCapture[] = [];
  const deps = {
    ctx: {
      conversationId: "conv-status-text",
      provider: { name: "anthropic" },
      streamThinking: false,
      emitActivityState: (
        phase: string,
        reason: string,
        options?: { anchor?: string; requestId?: string; statusText?: string },
      ) => {
        activityStates.push({
          phase,
          reason,
          anchor: options?.anchor,
          requestId: options?.requestId,
          statusText: options?.statusText,
        });
      },
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (_msg: ServerMessage) => {},
    reqId: "req-status-text",
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
  return { deps, activityStates };
}

// ── Pure helper tests ─────────────────────────────────────────────────────────

describe("formatSearchStatusText", () => {
  test("surfaces the query in quotes", () => {
    expect(formatSearchStatusText("web_search", "foo")).toBe('Searching "foo"');
  });

  test("truncates queries longer than 60 chars with an ellipsis", () => {
    const longQuery = "a".repeat(120);
    const result = formatSearchStatusText("web_search", longQuery);
    // 57 chars + "..." = 60 char body, wrapped in 'Searching "..."'
    expect(result).toBe(`Searching "${"a".repeat(57)}..."`);
  });

  test("preserves 60-char queries as-is (no truncation at the boundary)", () => {
    const sixty = "a".repeat(60);
    expect(formatSearchStatusText("web_search", sixty)).toBe(
      `Searching "${sixty}"`,
    );
  });

  test("falls back to the generic phrasing when the query is empty", () => {
    expect(formatSearchStatusText("web_search", "")).toBe("Searching the web");
    expect(formatSearchStatusText("web_search", "   ")).toBe(
      "Searching the web",
    );
  });

  test("emits 'Running <tool>' for non-web_search tools", () => {
    expect(formatSearchStatusText("other_tool", "x")).toBe(
      "Running other_tool",
    );
  });
});

describe("formatFetchStatusText", () => {
  test("returns the domain when given a parseable URL", () => {
    expect(formatFetchStatusText("https://example.com/path")).toBe(
      "Reading example.com",
    );
  });

  test("lowercases the host", () => {
    expect(formatFetchStatusText("https://EXAMPLE.COM/x")).toBe(
      "Reading example.com",
    );
  });

  test("falls back when the URL is unparseable or missing", () => {
    expect(formatFetchStatusText("not a url")).toBe("Reading a page");
    expect(formatFetchStatusText(undefined)).toBe("Reading a page");
    expect(formatFetchStatusText(42)).toBe("Reading a page");
  });
});

// ── Dispatch-path tests ───────────────────────────────────────────────────────

describe("server_tool_start status text", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    state = createEventHandlerState();
  });

  test("native web_search emits 'Searching \"<query>\"'", async () => {
    const { deps, activityStates } = createCollectorDeps();

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_start",
      name: "web_search",
      toolUseId: "tu_native_q",
      input: { query: "foo" },
    });

    const toolStart = activityStates.find((s) => s.reason === "tool_use_start");
    expect(toolStart?.statusText).toBe('Searching "foo"');
  });

  test("native web_search with long query truncates", async () => {
    const { deps, activityStates } = createCollectorDeps();
    const longQuery = "a".repeat(120);

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_start",
      name: "web_search",
      toolUseId: "tu_native_long",
      input: { query: longQuery },
    });

    const toolStart = activityStates.find((s) => s.reason === "tool_use_start");
    expect(toolStart?.statusText).toBe(`Searching "${"a".repeat(57)}..."`);
  });

  test("native web_search with missing query falls back to the generic phrasing", async () => {
    const { deps, activityStates } = createCollectorDeps();

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_start",
      name: "web_search",
      toolUseId: "tu_native_empty",
      input: {},
    });

    const toolStart = activityStates.find((s) => s.reason === "tool_use_start");
    expect(toolStart?.statusText).toBe("Searching the web");
  });
});

describe("tool_use status text (non-native)", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    state = createEventHandlerState();
  });

  test("web_search emits 'Searching \"<query>\"'", async () => {
    const { deps, activityStates } = createCollectorDeps();

    await dispatchAgentEvent(state, deps, {
      type: "tool_use",
      id: "tu_ws",
      name: "web_search",
      input: { query: "bar" },
    });

    const toolStart = activityStates.find((s) => s.reason === "tool_use_start");
    expect(toolStart?.statusText).toBe('Searching "bar"');
  });

  test("web_fetch emits 'Reading <domain>'", async () => {
    const { deps, activityStates } = createCollectorDeps();

    await dispatchAgentEvent(state, deps, {
      type: "tool_use",
      id: "tu_wf",
      name: "web_fetch",
      input: { url: "https://www.nytimes.com/article" },
    });

    const toolStart = activityStates.find((s) => s.reason === "tool_use_start");
    expect(toolStart?.statusText).toBe("Reading www.nytimes.com");
  });

  test("web_fetch with malformed url falls back to a generic phrase", async () => {
    const { deps, activityStates } = createCollectorDeps();

    await dispatchAgentEvent(state, deps, {
      type: "tool_use",
      id: "tu_wf_bad",
      name: "web_fetch",
      input: { url: "not-a-url" },
    });

    const toolStart = activityStates.find((s) => s.reason === "tool_use_start");
    expect(toolStart?.statusText).toBe("Reading a page");
  });

  test("unrelated tools keep the existing 'Running <friendly>' fallback", async () => {
    const { deps, activityStates } = createCollectorDeps();

    await dispatchAgentEvent(state, deps, {
      type: "tool_use",
      id: "tu_bash",
      name: "bash",
      input: { command: "ls" },
    });

    const toolStart = activityStates.find((s) => s.reason === "tool_use_start");
    expect(toolStart?.statusText).toBe("Running command");
  });
});
