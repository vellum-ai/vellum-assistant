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
          const handlers: Record<string, ((...args: unknown[]) => void)[]> =
            {};
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

// Import after mocking
import { AnthropicProvider } from "../providers/anthropic/client.js";

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

    await provider.sendMessage([userMsg("Hi")], sampleTools);

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

    await provider.sendMessage([userMsg("Hi")], sampleTools);

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

    await provider.sendMessage([userMsg("Hi")], toolsWithoutWebSearch);

    const tools = lastStreamParams!.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("file_read");
    expect(tools[0].type).toBeUndefined();
  });

  test("useNativeWebSearch=true puts cache_control on last custom tool, not on native web search tool", async () => {
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6", {
      useNativeWebSearch: true,
    });

    await provider.sendMessage([userMsg("Hi")], sampleTools);

    const tools = lastStreamParams!.tools as Array<{
      name: string;
      cache_control?: { type: string };
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
    await provider.sendMessage(
      [userMsg("Search something")],
      sampleTools,
      undefined,
      {
        onEvent: (event) => events.push(event),
      },
    );

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
    await provider.sendMessage(
      [userMsg("Read a file")],
      sampleTools,
      undefined,
      {
        onEvent: (event) => events.push(event),
      },
    );

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
