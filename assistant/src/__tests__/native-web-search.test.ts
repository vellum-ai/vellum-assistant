import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ContentBlock,
  Message,
  ProviderEvent,
  ToolDefinition,
} from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock Anthropic SDK — must be before importing the provider
// ---------------------------------------------------------------------------

let lastStreamParams: Record<string, unknown> | null = null;

/** Sequence of streamEvent callbacks to fire during stream processing. */
let pendingStreamEvents: Array<Record<string, unknown>> = [];

const fakeResponse = {
  content: [{ type: "text", text: "Hello" }],
  model: "claude-sonnet-4-6",
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  stop_reason: "end_turn",
};

/** Allow tests to override the fake response content blocks. */
let fakeResponseContent: Array<Record<string, unknown>> = fakeResponse.content;

class FakeAPIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "APIError";
  }
}

mock.module("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    static APIError = FakeAPIError;
    constructor(_args: Record<string, unknown>) {}
    beta = {
      messages: {
        stream: (
          params: Record<string, unknown>,
          _options?: Record<string, unknown>,
        ) => {
          lastStreamParams = JSON.parse(JSON.stringify(params));
          const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
          return {
            on(event: string, cb: (...args: unknown[]) => void) {
              (handlers[event] ??= []).push(cb);
              return this;
            },
            async finalMessage() {
              // Fire any pending stream events
              for (const ev of pendingStreamEvents) {
                for (const cb of handlers["streamEvent"] ?? []) cb(ev);
              }
              return { ...fakeResponse, content: fakeResponseContent };
            },
          };
        },
      },
    };
  },
}));

// Mock daemon collaborators the handler module imports at load time so the
// handler-level tests below can drive `server_tool_complete` in isolation.
mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  addMessage: () => ({ id: "mock-msg-id" }),
  getMessageById: () => null,
  updateMessageContent: () => {},
  provenanceFromTrustContext: () => ({}),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

// Import after mocking
import {
  createEventHandlerState,
  type EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import { AnthropicProvider } from "../providers/anthropic/client.js";
import { isNativeWebSearchCapableProvider } from "../providers/registry.js";
import { WEB_SEARCH_BACKEND_FAILURE_MESSAGE } from "../tools/network/web-search-error.js";
import {
  completeNativeWebSearch,
  createHandlerDeps,
  lastToolResult,
  toolResults,
} from "./helpers/native-web-search-harness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

const sampleTools: ToolDefinition[] = [
  {
    name: "file_read",
    description: "Read a file",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "web_search",
    description: "Search the web",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  },
];

describe("Native Web Search — Selection Semantics", () => {
  test("only native-capable inference providers/models request provider-native web search", () => {
    expect(
      isNativeWebSearchCapableProvider("anthropic", "claude-opus-4-7"),
    ).toBe(true);
    expect(isNativeWebSearchCapableProvider("openai", "gpt-5")).toBe(true);
    expect(
      isNativeWebSearchCapableProvider(
        "openrouter",
        "anthropic/claude-opus-4-7",
      ),
    ).toBe(true);

    expect(
      isNativeWebSearchCapableProvider(
        "fireworks",
        "accounts/fireworks/models/kimi-k2p6",
      ),
    ).toBe(false);
    expect(isNativeWebSearchCapableProvider("gemini", "gemini-3.1-pro")).toBe(
      false,
    );
    expect(isNativeWebSearchCapableProvider("openrouter", "openai/gpt-5")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — Round-trip: fromAnthropicBlock
// ---------------------------------------------------------------------------

describe("Native Web Search — Round-trip", () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    lastStreamParams = null;
    pendingStreamEvents = [];
    fakeResponseContent = fakeResponse.content;
    provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6", {
      useNativeWebSearch: true,
    });
  });

  test("fromAnthropicBlock converts server_tool_use block to ServerToolUseContent", async () => {
    fakeResponseContent = [
      {
        type: "server_tool_use",
        id: "stu_abc123",
        name: "web_search",
        input: { query: "test query" },
      },
    ];

    const result = await provider.sendMessage([
      userMsg("Search for something"),
    ]);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "server_tool_use",
      id: "stu_abc123",
      name: "web_search",
      input: { query: "test query" },
    });
  });

  test("fromAnthropicBlock converts web_search_tool_result block to WebSearchToolResultContent", async () => {
    const searchContent = [
      {
        type: "web_search_result",
        url: "https://example.com",
        title: "Example",
        encrypted_content: "enc_abc",
      },
    ];

    fakeResponseContent = [
      {
        type: "web_search_tool_result",
        tool_use_id: "stu_abc123",
        content: searchContent,
      },
    ];

    const result = await provider.sendMessage([
      userMsg("Search for something"),
    ]);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "web_search_tool_result",
      tool_use_id: "stu_abc123",
      content: searchContent,
    });
  });

  test("toAnthropicBlockSafe converts ServerToolUseContent back to ServerToolUseBlockParam", async () => {
    // Build a conversation that includes a server_tool_use block in the assistant history
    // to verify it round-trips correctly when sent back to the API.
    const messages: Message[] = [
      userMsg("Search for something"),
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "stu_abc123",
            name: "web_search",
            input: { query: "test query" },
          } satisfies ContentBlock,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "stu_abc123",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com",
                title: "Example",
                encrypted_content: "enc_abc",
              },
            ],
          } satisfies ContentBlock,
        ],
      },
    ];

    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;

    // The assistant message should contain the server_tool_use block
    const assistantMsg = sent.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const serverToolBlock = assistantMsg!.content.find(
      (b) => b.type === "server_tool_use",
    );
    expect(serverToolBlock).toEqual({
      type: "server_tool_use",
      id: "stu_abc123",
      name: "web_search",
      input: { query: "test query" },
    });
  });

  test("toAnthropicBlockSafe converts WebSearchToolResultContent back to WebSearchToolResultBlockParam", async () => {
    const searchContent = [
      {
        type: "web_search_result",
        url: "https://example.com",
        title: "Example",
        encrypted_content: "enc_abc",
      },
    ];

    const messages: Message[] = [
      userMsg("Search for something"),
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "stu_abc123",
            name: "web_search",
            input: { query: "test query" },
          } satisfies ContentBlock,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "stu_abc123",
            content: searchContent,
          } satisfies ContentBlock,
        ],
      },
    ];

    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;

    // The user message after assistant should contain the web_search_tool_result block
    const userMsgs = sent.filter((m) => m.role === "user");
    const lastUser = userMsgs[userMsgs.length - 1];
    const resultBlock = lastUser.content.find(
      (b) => b.type === "web_search_tool_result",
    );
    expect(resultBlock).toMatchObject({
      type: "web_search_tool_result",
      tool_use_id: "stu_abc123",
      content: searchContent,
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — Tool filtering / swapping
// ---------------------------------------------------------------------------

describe("Native Web Search — Tool Filtering", () => {
  beforeEach(() => {
    lastStreamParams = null;
    pendingStreamEvents = [];
    fakeResponseContent = fakeResponse.content;
  });

  test("useNativeWebSearch=true replaces custom web_search with WebSearchTool20250305", async () => {
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6", {
      useNativeWebSearch: true,
    });

    await provider.sendMessage([userMsg("Hi")], { tools: sampleTools });

    const tools = lastStreamParams!.tools as Array<Record<string, unknown>>;

    // Should have 2 tools: file_read (custom) + web_search (native)
    expect(tools).toHaveLength(2);

    // First tool: file_read (custom tool definition)
    expect(tools[0].name).toBe("file_read");
    expect(tools[0].type).toBeUndefined(); // Custom tools don't have a type field in params

    // Second tool: native web search with special type
    expect(tools[1]).toMatchObject({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
    });
    // Native tool should NOT have input_schema or description
    expect(tools[1].input_schema).toBeUndefined();
    expect(tools[1].description).toBeUndefined();
  });

  test("useNativeWebSearch=false passes custom web_search tool unchanged", async () => {
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6", {
      useNativeWebSearch: false,
    });

    await provider.sendMessage([userMsg("Hi")], { tools: sampleTools });

    const tools = lastStreamParams!.tools as Array<Record<string, unknown>>;

    // Should have both tools as custom definitions
    expect(tools).toHaveLength(2);

    expect(tools[0].name).toBe("file_read");
    expect(tools[0].description).toBe("Read a file");
    expect(tools[0].input_schema).toBeDefined();

    expect(tools[1].name).toBe("web_search");
    expect(tools[1].description).toBe("Search the web");
    expect(tools[1].input_schema).toBeDefined();
    // Should NOT have the native web search type
    expect(tools[1].type).toBeUndefined();
  });

  test("useNativeWebSearch=true with no web_search tool passes tools through unchanged", async () => {
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6", {
      useNativeWebSearch: true,
    });

    const toolsWithoutWebSearch: ToolDefinition[] = [
      {
        name: "file_read",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ];

    await provider.sendMessage([userMsg("Hi")], {
      tools: toolsWithoutWebSearch,
    });

    const tools = lastStreamParams!.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("file_read");
    expect(tools[0].type).toBeUndefined();
  });

  test("useNativeWebSearch=true puts cache_control on last custom tool, not on native web search tool", async () => {
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6", {
      useNativeWebSearch: true,
    });

    await provider.sendMessage([userMsg("Hi")], { tools: sampleTools });

    const tools = lastStreamParams!.tools as Array<{
      name: string;
      cache_control?: { type: string; ttl?: string };
    }>;

    // file_read is the last custom tool (only custom tool in this case)
    // and it should get cache_control since it's the last in the mappedOther list
    expect(tools[0].name).toBe("file_read");
    expect(tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // Native web search tool should NOT have cache_control set by the mapping logic
    // (it's appended after the mapped custom tools)
    expect(tools[1].name).toBe("web_search");
  });
});

// ---------------------------------------------------------------------------
// Tests — Streaming server_tool_start event
// ---------------------------------------------------------------------------

describe("Native Web Search — Streaming Events", () => {
  beforeEach(() => {
    lastStreamParams = null;
    pendingStreamEvents = [];
    fakeResponseContent = fakeResponse.content;
  });

  test("content_block_start with server_tool_use emits server_tool_start event", async () => {
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6", {
      useNativeWebSearch: true,
    });

    pendingStreamEvents = [
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: "stu_stream123",
          name: "web_search",
        },
      },
    ];

    const events: ProviderEvent[] = [];
    await provider.sendMessage([userMsg("Search something")], {
      tools: sampleTools,
      onEvent: (event) => events.push(event),
    });

    const serverToolEvents = events.filter(
      (e) => e.type === "server_tool_start",
    );
    expect(serverToolEvents).toHaveLength(1);
    expect(serverToolEvents[0]).toEqual({
      type: "server_tool_start",
      name: "web_search",
      toolUseId: "stu_stream123",
      input: {},
    });
  });

  test("content_block_start with regular tool_use does not emit server_tool_start", async () => {
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6", {
      useNativeWebSearch: true,
    });

    pendingStreamEvents = [
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tu_regular",
          name: "file_read",
        },
      },
    ];

    const events: ProviderEvent[] = [];
    await provider.sendMessage([userMsg("Read a file")], {
      tools: sampleTools,
      onEvent: (event) => events.push(event),
    });

    const serverToolEvents = events.filter(
      (e) => e.type === "server_tool_start",
    );
    expect(serverToolEvents).toHaveLength(0);

    // Should emit tool_use_preview_start instead
    const toolUseEvents = events.filter(
      (e) => e.type === "tool_use_preview_start",
    );
    expect(toolUseEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — Native server_tool_complete backend-failure handling (ATL-727)
// ---------------------------------------------------------------------------

describe("Native Web Search — Backend Failure Handling", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    state = createEventHandlerState();
  });

  test("backend failure surfaces friendly copy with isError true and empty results", async () => {
    const { deps, events } = createHandlerDeps();
    await completeNativeWebSearch(state, deps, "tu_backend", {
      isError: true,
      errorCode: "unavailable",
    });

    const result = lastToolResult(events);
    expect(result?.activityMetadata?.webSearch?.errorMessage).toBe(
      WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
    );
    expect(result?.isError).toBe(true);
    expect(result?.activityMetadata?.webSearch?.resultCount).toBe(0);
    expect(result?.activityMetadata?.webSearch?.results).toEqual([]);
  });

  test("raw error_code is logged under web_search_backend_failure but absent from user copy", async () => {
    const { deps, events, warnings } = createHandlerDeps();
    await completeNativeWebSearch(state, deps, "tu_log", {
      isError: true,
      errorCode: "unavailable",
    });

    const failureLog = warnings.find(
      (w) => w.obj.event === "web_search_backend_failure",
    );
    expect(failureLog).toBeDefined();
    expect(failureLog?.obj.provider).toBe("anthropic-native");
    expect(String(failureLog?.obj.rawDetail)).toContain("unavailable");
    expect(failureLog?.obj.fallbackShown).toBe(true);

    const errorMessage =
      lastToolResult(events)?.activityMetadata?.webSearch?.errorMessage;
    expect(errorMessage).not.toContain("unavailable");
  });

  test("dedups repeat backend failures within one turn to a single friendly notice", async () => {
    const { deps, events, warnings } = createHandlerDeps();

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
    expect(results[0]?.activityMetadata?.webSearch?.errorMessage).toBe(
      WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
    );
    // The second backend failure in the same turn is terse, not the full notice.
    expect(results[1]?.activityMetadata?.webSearch?.errorMessage).not.toBe(
      WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
    );

    const failureLogs = warnings.filter(
      (w) => w.obj.event === "web_search_backend_failure",
    );
    // Both failures are logged, but only the first reports fallbackShown.
    expect(failureLogs).toHaveLength(2);
    expect(
      failureLogs.filter((w) => w.obj.fallbackShown === true),
    ).toHaveLength(1);
  });

  test("successful search leaves errorMessage undefined and populates results", async () => {
    const { deps, events, warnings } = createHandlerDeps();
    await completeNativeWebSearch(state, deps, "tu_ok", {
      isError: false,
      content: [
        {
          type: "web_search_result",
          title: "Weather",
          url: "https://example.com/weather",
        },
      ],
    });

    const meta = lastToolResult(events)?.activityMetadata?.webSearch;
    expect(meta?.errorMessage).toBeUndefined();
    expect(meta?.resultCount).toBe(1);
    expect(meta?.results[0]?.title).toBe("Weather");
    expect(lastToolResult(events)?.isError).toBe(false);
    expect(
      warnings.filter((w) => w.obj.event === "web_search_backend_failure"),
    ).toHaveLength(0);
  });

  test("query_too_long yields a distinct non-backend message", async () => {
    const { deps, events, warnings } = createHandlerDeps();
    await completeNativeWebSearch(state, deps, "tu_long", {
      isError: true,
      errorCode: "query_too_long",
    });

    const errorMessage =
      lastToolResult(events)?.activityMetadata?.webSearch?.errorMessage;
    expect(errorMessage).toBeDefined();
    expect(errorMessage).not.toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    // Recoverable non-backend errors must NOT emit backend-failure telemetry.
    expect(
      warnings.filter((w) => w.obj.event === "web_search_backend_failure"),
    ).toHaveLength(0);
  });

  test("message-less native failure (no error_code) surfaces friendly copy, not the terse 'Search failed' placeholder, and emits no backend telemetry", async () => {
    const { deps, events, warnings } = createHandlerDeps("req-unknown");
    // `isError:true` with no error_code/message classifies as `unknown`
    // (isBackendFailure:false, empty userMessage). It must still get the
    // friendly copy rather than the bare "Search failed".
    await completeNativeWebSearch(state, deps, "tu_unknown", {
      isError: true,
    });

    const result = lastToolResult(events);
    const meta = result?.activityMetadata?.webSearch;
    expect(meta?.errorMessage).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    expect(meta?.errorMessage).not.toBe("Search failed");
    expect(result?.isError).toBe(true);
    expect(meta?.resultCount).toBe(0);
    expect(meta?.results).toEqual([]);

    // An unclassifiable failure borrows the friendly copy but must NOT be
    // logged as a backend outage.
    expect(
      warnings.filter((w) => w.obj.event === "web_search_backend_failure"),
    ).toHaveLength(0);
  });
});
