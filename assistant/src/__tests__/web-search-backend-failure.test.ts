// End-to-end integration coverage for the centralized web_search
// backend-failure normalization layer (ATL-727).
//
// PRs 1-4 built the layer in three places:
//   - `tools/network/web-search-error.ts` — `classifyWebSearchFailure` +
//     `WEB_SEARCH_BACKEND_FAILURE_MESSAGE` + the structured
//     `web_search_backend_failure` log helper.
//   - `daemon/conversation-agent-loop-handlers.ts` — the native
//     `server_tool_complete` handler maps Anthropic backend failures to the
//     friendly copy, dedups per turn (`webSearchBackendFailureNotified`), and
//     gates telemetry on `classification.isBackendFailure`.
//   - `tools/network/web-search.ts` — the app-side `backendFailureResult`
//     helper routes 5xx/network/429 to the same copy.
//
// This file locks the cross-cutting acceptance criteria in one place by
// driving the real handler + the real classifier end to end:
//   - friendly copy surfaced to the client,
//   - raw provider detail logged-not-shown,
//   - per-turn dedup,
//   - honest continuation (the failure is a recoverable tool_result, not a
//     thrown provider error; the search is never marked successful),
//   - web_fetch DNS failures are NOT conflated with the search backend copy,
//   - a successful empty search stays successful (no telemetry, no errorMessage).
//
// The native path reuses the handler harness from PR 2's
// `native-web-search.test.ts`; the web_fetch invariant is exercised through
// the same `handleToolResult` path an app-executed fetch tool drives.

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolActivityMetadata } from "../daemon/message-types/web-activity.js";

// ---------------------------------------------------------------------------
// Mock the daemon collaborators the handler module imports at load time so the
// handler can be driven in isolation (mirrors native-web-search.test.ts).
// ---------------------------------------------------------------------------

mock.module("../config/loader.js", () => ({
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

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: () => ({ id: "mock-msg-id" }),
  getMessageById: () => null,
  updateMessageContent: () => {},
  provenanceFromTrustContext: () => ({}),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../memory/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

// Import after mocking.
import {
  createEventHandlerState,
  dispatchAgentEvent,
  type EventHandlerDeps,
  type EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { WEB_SEARCH_BACKEND_FAILURE_MESSAGE } from "../tools/network/web-search-error.js";

// ---------------------------------------------------------------------------
// Handler harness
// ---------------------------------------------------------------------------

type ToolResultEvent = Extract<ServerMessage, { type: "tool_result" }>;

interface LogRecord {
  obj: Record<string, unknown>;
  msg?: string;
}

function createHandlerDeps(reqId = "req-web-search"): {
  deps: EventHandlerDeps;
  events: ServerMessage[];
  warnings: LogRecord[];
} {
  const events: ServerMessage[] = [];
  const warnings: LogRecord[] = [];
  const rlog = {
    warn: (obj: Record<string, unknown>, msg?: string) =>
      warnings.push({ obj, msg }),
    info: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
  };
  const deps = {
    ctx: {
      conversationId: "conv-web-search",
      provider: { name: "anthropic" },
      traceEmitter: { emit: () => {} },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (msg: ServerMessage) => events.push(msg),
    reqId,
    isFirstMessage: false,
    shouldGenerateTitle: false,
    rlog: rlog as unknown as EventHandlerDeps["rlog"],
    turnChannelContext: {
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
    } as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    } as EventHandlerDeps["turnInterfaceContext"],
  } as EventHandlerDeps;
  return { deps, events, warnings };
}

/** Drive one native (Anthropic) web_search start → complete pair. */
async function completeNativeWebSearch(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  toolUseId: string,
  event: {
    isError: boolean;
    errorCode?: string;
    errorMessage?: string;
    content?: unknown[];
  },
): Promise<void> {
  await dispatchAgentEvent(state, deps, {
    type: "server_tool_start",
    name: "web_search",
    toolUseId,
    input: { query: "what is the weather" },
  });
  await dispatchAgentEvent(state, deps, {
    type: "server_tool_complete",
    toolUseId,
    isError: event.isError,
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
    content: event.content ?? [],
  });
}

function toolResults(events: ServerMessage[]): ToolResultEvent[] {
  return events.filter((e): e is ToolResultEvent => e.type === "tool_result");
}

function lastToolResult(events: ServerMessage[]): ToolResultEvent | undefined {
  const results = toolResults(events);
  return results[results.length - 1];
}

function backendFailureLogs(warnings: LogRecord[]): LogRecord[] {
  return warnings.filter((w) => w.obj.event === "web_search_backend_failure");
}

describe("web_search backend-failure end-to-end (ATL-727)", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    state = createEventHandlerState();
  });

  test("native backend failure surfaces friendly copy, empty results, and logs raw detail not shown to the user", async () => {
    const { deps, events, warnings } = createHandlerDeps();

    await completeNativeWebSearch(state, deps, "tu_native", {
      isError: true,
      errorCode: "unavailable",
    });

    const result = lastToolResult(events);
    expect(result).toBeDefined();
    expect(result?.isError).toBe(true);

    const meta = result?.activityMetadata?.webSearch;
    expect(meta?.errorMessage).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    expect(meta?.provider).toBe("anthropic-native");
    expect(meta?.resultCount).toBe(0);
    expect(meta?.results).toEqual([]);

    // Raw provider detail is captured in telemetry only.
    const failureLog = backendFailureLogs(warnings)[0];
    expect(failureLog).toBeDefined();
    expect(failureLog?.obj.errorCategory).toBe("backend_unavailable");
    expect(failureLog?.obj.fallbackShown).toBe(true);
    expect(String(failureLog?.obj.rawDetail)).toContain("unavailable");

    // ...and never leaks into the user-facing copy.
    expect(meta?.errorMessage).not.toContain("unavailable");
    expect(result?.result).not.toContain("unavailable");
  });

  test("dedups two native backend failures in one turn to a single full notice", async () => {
    const { deps, events, warnings } = createHandlerDeps("req-dedup-turn");

    await completeNativeWebSearch(state, deps, "tu_dup_1", {
      isError: true,
      errorCode: "unavailable",
    });
    await completeNativeWebSearch(state, deps, "tu_dup_2", {
      isError: true,
      errorCode: "overloaded_error",
    });

    const results = toolResults(events);
    expect(results).toHaveLength(2);

    // First failure gets the full friendly notice; the second is terse.
    expect(results[0]?.activityMetadata?.webSearch?.errorMessage).toBe(
      WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
    );
    expect(results[1]?.activityMetadata?.webSearch?.errorMessage).not.toBe(
      WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
    );

    // Both failures are still logged; exactly one reports fallbackShown.
    const logs = backendFailureLogs(warnings);
    expect(logs).toHaveLength(2);
    expect(logs.filter((w) => w.obj.fallbackShown === true)).toHaveLength(1);
  });

  test("backend failure stays an honest, recoverable tool result (not a thrown provider error, never marked successful)", async () => {
    const { deps, events } = createHandlerDeps("req-honesty");

    // A recoverable backend failure flows as a tool_result, so dispatch must
    // resolve without throwing.
    await expect(
      completeNativeWebSearch(state, deps, "tu_honesty", {
        isError: true,
        errorCode: "unavailable",
      }),
    ).resolves.toBeUndefined();

    const result = lastToolResult(events);
    // The search is never silently upgraded to a success.
    expect(result?.isError).toBe(true);
    expect(result?.activityMetadata?.webSearch?.resultCount).toBe(0);
    expect(result?.activityMetadata?.webSearch?.results).toEqual([]);
  });

  test("web_fetch DNS failure is NOT conflated with the web_search backend copy", async () => {
    // The normalization layer keys exclusively on web_search (the native
    // `server_tool_complete` handler and `web-search.ts`). It never inspects
    // `webFetch` metadata. handleToolResult forwards an app-executed tool's
    // `activityMetadata` verbatim, so a web_fetch DNS failure must reach the
    // client with its own copy and acquire NO `webSearch` metadata. Drive that
    // path directly with a DNS-failure fetch result for grimgoods.io.
    const { deps, events, warnings } = createHandlerDeps("req-web-fetch");

    const dnsError =
      'Error: Unable to resolve host "grimgoods.io" (DNS lookup failed)';
    const fetchMetadata: ToolActivityMetadata = {
      webFetch: {
        url: "https://grimgoods.io",
        finalUrl: "https://grimgoods.io",
        status: 0,
        byteCount: 0,
        charCount: 0,
        truncated: false,
        domain: "grimgoods.io",
        redirectCount: 0,
        durationMs: 12,
        errorMessage: dnsError,
      },
    };

    await dispatchAgentEvent(state, deps, {
      type: "tool_use",
      id: "tu_fetch",
      name: "web_fetch",
      input: { url: "https://grimgoods.io" },
    });
    await dispatchAgentEvent(state, deps, {
      type: "tool_result",
      toolUseId: "tu_fetch",
      content: dnsError,
      isError: true,
      activityMetadata: fetchMetadata,
    });

    const result = lastToolResult(events);
    expect(result?.isError).toBe(true);

    // The DNS error keeps its own webFetch copy untouched...
    expect(result?.activityMetadata?.webFetch?.errorMessage).toBe(dnsError);
    // ...and is never rewritten to the search backend copy.
    expect(result?.activityMetadata?.webFetch?.errorMessage).not.toBe(
      WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
    );
    // No webSearch metadata is fabricated for a fetch failure.
    expect(result?.activityMetadata?.webSearch).toBeUndefined();
    // And the web_search backend-failure telemetry never fires for a fetch.
    expect(backendFailureLogs(warnings)).toHaveLength(0);
  });

  test("successful empty native search stays successful with no telemetry and no errorMessage", async () => {
    const { deps, events, warnings } = createHandlerDeps("req-no-results");

    await completeNativeWebSearch(state, deps, "tu_empty", {
      isError: false,
      content: [],
    });

    const result = lastToolResult(events);
    expect(result?.isError).toBe(false);

    const meta = result?.activityMetadata?.webSearch;
    expect(meta?.resultCount).toBe(0);
    expect(meta?.results).toEqual([]);
    expect(meta?.errorMessage).toBeUndefined();

    // No-results is a success, not a backend failure: no telemetry fires.
    expect(backendFailureLogs(warnings)).toHaveLength(0);
  });
});
