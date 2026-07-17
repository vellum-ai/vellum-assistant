/**
 * Tests that the native Anthropic `server_tool_complete` agent event produces
 * a structured `WebSearchMetadata` payload on the emitted `tool_result` server
 * message while keeping the back-compat `result: string` byte-identical.
 *
 * Mirrors the mocked-dependency collector pattern used in
 * tool-result-metadata-plumbing.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";

// The finalize path indexes tool-result messages into memory; keep it inert
// (the old partial mock omitted memory, leaving it disabled) so no real
// embedding backend is touched.
setConfig("memory", { enabled: false, v2: { enabled: false } });

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
import { WEB_SEARCH_BACKEND_FAILURE_MESSAGE } from "../../tools/network/web-search-error.js";
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

function createCollectorDeps(providerName = "anthropic"): {
  deps: EventHandlerDeps;
  events: ServerMessage[];
} {
  const events: ServerMessage[] = [];
  const deps = {
    ctx: {
      conversationId: "conv-native-meta",
      provider: { name: providerName },
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
    applyCompaction: async () => {},
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

    // Favicons are synthesized from the result domain so clients can render
    // a per-result icon without an extra round-trip.
    expect(meta?.results[0]?.faviconUrl).toContain("google.com/s2/favicons");
    expect(meta?.results[1]?.faviconUrl).toContain("google.com/s2/favicons");

    // Back-compat: result text must be byte-identical to the legacy format.
    expect(toolResultEvent?.result).toBe(
      "X\nhttps://www.cnn.com/a\n\nY\nhttps://www.nbcnews.com/b",
    );

    // Per-toolUseId scratch maps must be cleaned up after completion.
    expect(state.serverToolStartedAt.has(toolUseId)).toBe(false);
    expect(state.serverToolInputs.has(toolUseId)).toBe(false);
  });

  test("prefers `resolvedInput.query` over the input captured at server_tool_start", async () => {
    // Mirrors the live Anthropic flow: server_tool_start fires with `input: {}`
    // because the SDK streams server-tool input via `input_json_delta`, then
    // the provider populates `resolvedInput` on `server_tool_complete` from
    // the accumulated JSON. Without this plumb-through, `meta.query` is empty.
    const { deps, events } = createCollectorDeps();
    const toolUseId = "tu_resolved";

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_start",
      name: "web_search",
      toolUseId,
      input: {},
    });

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_complete",
      toolUseId,
      isError: false,
      resolvedInput: { query: "OpenAI Dev Day recap" },
      content: [
        {
          type: "web_search_result",
          title: "Recap",
          url: "https://example.com/a",
        },
      ],
    });

    const toolResultEvent = events.find(
      (e): e is ToolResultEvent => e.type === "tool_result",
    );
    expect(toolResultEvent?.activityMetadata?.webSearch?.query).toBe(
      "OpenAI Dev Day recap",
    );
  });

  test("fires per-toolUseId for parallel server tool calls with independent queries and timings", async () => {
    const { deps, events } = createCollectorDeps();

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_start",
      name: "web_search",
      toolUseId: "tu_a",
      input: { query: "alpha" },
    });
    await dispatchAgentEvent(state, deps, {
      type: "server_tool_start",
      name: "web_search",
      toolUseId: "tu_b",
      input: { query: "beta" },
    });

    // Hold long enough that the two completions can't share a duration.
    await new Promise((r) => setTimeout(r, 20));

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_complete",
      toolUseId: "tu_a",
      isError: false,
      content: [
        {
          type: "web_search_result",
          title: "A1",
          url: "https://a.example.com/1",
        },
      ],
    });

    await new Promise((r) => setTimeout(r, 20));

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_complete",
      toolUseId: "tu_b",
      isError: false,
      content: [
        {
          type: "web_search_result",
          title: "B1",
          url: "https://b.example.com/1",
        },
      ],
    });

    const toolResults = events.filter(
      (e): e is ToolResultEvent => e.type === "tool_result",
    );
    expect(toolResults).toHaveLength(2);

    const byId = new Map(toolResults.map((r) => [r.toolUseId, r] as const));
    expect(byId.get("tu_a")?.activityMetadata?.webSearch?.query).toBe("alpha");
    expect(byId.get("tu_b")?.activityMetadata?.webSearch?.query).toBe("beta");

    const durA = byId.get("tu_a")?.activityMetadata?.webSearch?.durationMs ?? 0;
    const durB = byId.get("tu_b")?.activityMetadata?.webSearch?.durationMs ?? 0;
    // Each duration is computed against its own startedAt — tu_b should run
    // longer because we slept once more between its start and its complete.
    expect(durB).toBeGreaterThanOrEqual(durA);
  });

  test("maps recoverable error codes to friendly copy, not the raw code", async () => {
    const { deps, events } = createCollectorDeps();
    const toolUseId = "tu_err_code";

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_start",
      name: "web_search",
      toolUseId,
      input: { query: "over the limit" },
    });

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_complete",
      toolUseId,
      isError: true,
      errorCode: "max_uses_exceeded",
      content: [],
    });

    const toolResultEvent = events.find(
      (e): e is ToolResultEvent => e.type === "tool_result",
    );
    const errorMessage =
      toolResultEvent?.activityMetadata?.webSearch?.errorMessage;
    // The raw provider code is never user-visible.
    expect(errorMessage).not.toBe("max_uses_exceeded");
    expect(errorMessage).toContain("web-search limit");
  });

  test("does NOT emit activityMetadata for non-Anthropic providers", async () => {
    // OpenAI's responses provider shares `server_tool_start`/`server_tool_complete`
    // for `web_search_call`, but its results live inside the assistant text
    // stream — emitting "anthropic-native" metadata for an OpenAI search would
    // mis-label the provider and ship an empty `results` array.
    const { deps, events } = createCollectorDeps("openai");
    const toolUseId = "tu_openai";

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_start",
      name: "web_search",
      toolUseId,
      input: {},
    });

    await dispatchAgentEvent(state, deps, {
      type: "server_tool_complete",
      toolUseId,
      isError: false,
    });

    const toolResultEvent = events.find(
      (e): e is ToolResultEvent => e.type === "tool_result",
    );
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent?.activityMetadata).toBeUndefined();
    // The back-compat `result: string` channel still fires (empty for OpenAI
    // since the results are woven into the text stream, not structured).
    expect(toolResultEvent?.result).toBe("");
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
    expect(meta?.errorMessage).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    expect(meta?.resultCount).toBe(0);
    expect(meta?.results).toEqual([]);
    expect(toolResultEvent?.isError).toBe(true);
  });
});
