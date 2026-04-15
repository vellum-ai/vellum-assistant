import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message, ToolDefinition } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock Anthropic SDK — must be before importing the provider
// ---------------------------------------------------------------------------

let lastStreamParams: Record<string, unknown> | null = null;
let _lastStreamOptions: Record<string, unknown> | null = null;
let lastConstructorArgs: Record<string, unknown> | null = null;

const fakeResponse = {
  content: [{ type: "text", text: "Hello" }],
  model: "claude-sonnet-4-6",
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 50,
    cache_read_input_tokens: 30,
  },
  stop_reason: "end_turn",
};

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
    constructor(args: Record<string, unknown>) {
      lastConstructorArgs = { ...args };
    }
    #streamImpl = (
      params: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      lastStreamParams = JSON.parse(JSON.stringify(params));
      _lastStreamOptions = options ?? null;
      const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
      return {
        on(event: string, cb: (...args: unknown[]) => void) {
          (handlers[event] ??= []).push(cb);
          return this;
        },
        async finalMessage() {
          // Fire text events
          for (const cb of handlers["text"] ?? []) cb("Hello");
          return fakeResponse;
        },
      };
    };
    messages = {
      stream: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => this.#streamImpl(params, options),
    };
    beta = {
      messages: {
        stream: (
          params: Record<string, unknown>,
          options?: Record<string, unknown>,
        ) => this.#streamImpl(params, options),
      },
    };
  },
}));

// Import after mocking
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../prompts/system-prompt.js";
import {
  AnthropicProvider,
  PLACEHOLDER_BLOCKS_OMITTED,
  PLACEHOLDER_EMPTY_TURN,
} from "../providers/anthropic/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolUseMsg(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  };
}

function toolResultMsg(toolUseId: string, content: string): Message {
  return {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: toolUseId, content, is_error: false },
    ],
  };
}

const sampleTools: ToolDefinition[] = [
  {
    name: "file_read",
    description: "Read a file",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "file_write",
    description: "Write a file",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
    },
  },
  {
    name: "bash",
    description: "Run shell commands",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
    },
  },
];

// ---------------------------------------------------------------------------
// Tests — Cache-Control Characterization
// ---------------------------------------------------------------------------

describe("AnthropicProvider — Cache-Control Characterization", () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    lastStreamParams = null;
    _lastStreamOptions = null;
    lastConstructorArgs = null;
    provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");
  });

  // -----------------------------------------------------------------------
  // System prompt cache control
  // -----------------------------------------------------------------------
  test("system prompt has cache_control ephemeral with 1h TTL", async () => {
    await provider.sendMessage([userMsg("Hi")], undefined, "You are helpful.");

    const system = lastStreamParams!.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(system).toHaveLength(1);
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("no system param when system prompt is omitted", async () => {
    await provider.sendMessage([userMsg("Hi")]);

    expect(lastStreamParams!.system).toBeUndefined();
  });

  test("splits system prompt into two cache blocks on boundary marker", async () => {
    const staticBlock = "You are a helpful assistant.";
    const dynamicBlock = "User workspace files here.";
    const prompt = staticBlock + SYSTEM_PROMPT_CACHE_BOUNDARY + dynamicBlock;

    await provider.sendMessage([userMsg("Hi")], undefined, prompt);

    const system = lastStreamParams!.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(system).toHaveLength(2);
    expect(system[0].text).toBe(staticBlock);
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(system[1].text).toBe(dynamicBlock);
    expect(system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("drops static system block cache_control when total would exceed 4", async () => {
    const staticBlock = "You are a helpful assistant.";
    const dynamicBlock = "User workspace files here.";
    const prompt = staticBlock + SYSTEM_PROMPT_CACHE_BOUNDARY + dynamicBlock;

    // Boundary (2 system) + tools (1) + turn-start (1) + tail (1) = 5 → must cap at 4
    const messages: Message[] = [
      userMsg("Do something"),
      toolUseMsg("tu_1", "bash"),
      toolResultMsg("tu_1", "output"),
    ];
    await provider.sendMessage(messages, sampleTools, prompt);

    const system = lastStreamParams!.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(system).toHaveLength(2);
    // Static block's cache_control dropped (small, cheap to re-read)
    expect(system[0].cache_control).toBeUndefined();
    // Dynamic block keeps its cache_control
    expect(system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // Tools breakpoint still present
    const tools = lastStreamParams!.tools as Array<{
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(tools[tools.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    // Turn-start + tail breakpoints still present
    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const turnStart = sent[0];
    expect(
      turnStart.content[turnStart.content.length - 1].cache_control,
    ).toEqual({ type: "ephemeral", ttl: "1h" });
    const lastMsg = sent[sent.length - 1];
    expect(lastMsg.content[lastMsg.content.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
  });

  // -----------------------------------------------------------------------
  // Tool cache control
  // -----------------------------------------------------------------------
  test("only last tool definition includes cache_control", async () => {
    await provider.sendMessage([userMsg("Hi")], sampleTools);

    const tools = lastStreamParams!.tools as Array<{
      name: string;
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(tools).toHaveLength(3);

    // First two tools: no cache_control
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toBeUndefined();

    // Last tool: cache_control ephemeral
    expect(tools[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("single tool gets cache_control", async () => {
    await provider.sendMessage([userMsg("Hi")], [sampleTools[0]]);

    const tools = lastStreamParams!.tools as Array<{
      name: string;
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("no tools param when tools are omitted", async () => {
    await provider.sendMessage([userMsg("Hi")]);

    expect(lastStreamParams!.tools).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Advancing tail — 5m cache on last block after turn-starting message
  // -----------------------------------------------------------------------
  test("no advancing tail cache when turn-starting user message is last", async () => {
    await provider.sendMessage([userMsg("Hello")]);

    // No top-level cache_control — would conflict with the 1h block breakpoint
    expect(
      (lastStreamParams as Record<string, unknown>).cache_control,
    ).toBeUndefined();
  });

  test("advancing tail: 5m cache on last block when tool results follow turn-starting message", async () => {
    const messages: Message[] = [
      userMsg("Do something"),
      toolUseMsg("tu_1", "bash"),
      toolResultMsg("tu_1", "output"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;

    // Turn-starting user message (first) keeps 1h
    const turnStart = sent[0];
    const turnStartLast = turnStart.content[turnStart.content.length - 1];
    expect(turnStartLast.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    // Last message (tool_result) gets 5m advancing tail
    const lastMessage = sent[sent.length - 1];
    const lastBlock = lastMessage.content[lastMessage.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  test("turn-starting user message gets 1h cache on last block", async () => {
    const messages: Message[] = [
      userMsg("Turn 1"),
      assistantMsg("Response 1"),
      userMsg("Turn 2"),
      assistantMsg("Response 2"),
      userMsg("Turn 3"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;

    const userMessages = sent.filter((m) => m.role === "user");
    // Only the last user message (turn-starting) gets cache_control
    for (const user of userMessages.slice(0, -1)) {
      for (const block of user.content) {
        expect(block.cache_control).toBeUndefined();
      }
    }
    const lastUser = userMessages[userMessages.length - 1];
    const lastBlock = lastUser.content[lastUser.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  // -----------------------------------------------------------------------
  // Negative: assistant messages never get cache_control
  // -----------------------------------------------------------------------
  test("assistant messages do not get cache_control", async () => {
    const messages: Message[] = [
      userMsg("Hi"),
      assistantMsg("Hello!"),
      userMsg("How are you?"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const assistantMsgs = sent.filter((m) => m.role === "assistant");
    for (const a of assistantMsgs) {
      if (Array.isArray(a.content)) {
        for (const block of a.content) {
          expect(block.cache_control).toBeUndefined();
        }
      }
    }
  });

  // -----------------------------------------------------------------------
  // Multi-block user message: cache lands on LAST block
  // -----------------------------------------------------------------------
  test("multi-block single user message gets cache on last block", async () => {
    const multiBlockUser: Message = {
      role: "user",
      content: [
        { type: "text", text: "First block" },
        { type: "text", text: "Second block" },
      ],
    };
    await provider.sendMessage([multiBlockUser]);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const user = sent[0];
    expect(user.content[0].cache_control).toBeUndefined();
    expect(user.content[1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  // -----------------------------------------------------------------------
  // Usage: cache tokens are aggregated into inputTokens
  // -----------------------------------------------------------------------
  test("usage aggregates cache tokens into inputTokens", async () => {
    const result = await provider.sendMessage([userMsg("Hi")]);

    expect(result.usage.inputTokens).toBe(100 + 50 + 30); // input + creation + read
    expect(result.usage.cacheCreationInputTokens).toBe(50);
    expect(result.usage.cacheReadInputTokens).toBe(30);
  });

  // -----------------------------------------------------------------------
  // Cache compatibility with workspace context injection
  // -----------------------------------------------------------------------
  test("workspace-prepended single user message gets cache on last block", async () => {
    // Simulates what applyRuntimeInjections does: prepend workspace block, keep user text as trailing
    const workspaceInjectedUser: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: "<workspace>\nRoot: /sandbox\nDirectories: src, tests\n</workspace>",
        },
        { type: "text", text: "What files are in src?" },
      ],
    };
    await provider.sendMessage([workspaceInjectedUser]);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const user = sent[0];
    expect(user.content).toHaveLength(2);
    // Workspace block (first): no cache_control
    expect(user.content[0].cache_control).toBeUndefined();
    // User text (last): cache_control with 1h TTL
    expect(user.content[1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  test("workspace + multi-block single user message: cache on last block only", async () => {
    // Simulates workspace prepended + extra context block appended
    const injectedUser: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: "<workspace>\nRoot: /sandbox\nDirectories: src, tests\n</workspace>",
        },
        { type: "text", text: "Help me debug this" },
        {
          type: "text",
          text: "<dynamic_profile>\nUser prefers TypeScript.\n</dynamic_profile>",
        },
      ],
    };
    await provider.sendMessage([injectedUser]);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const user = sent[0];
    expect(user.content).toHaveLength(3);
    // Only last block gets cache_control
    expect(user.content[0].cache_control).toBeUndefined();
    expect(user.content[1].cache_control).toBeUndefined();
    expect(user.content[2].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  // -----------------------------------------------------------------------
  // ensureToolPairing — tool_use / tool_result pairing repair
  // -----------------------------------------------------------------------

  test("tool_use with missing tool_result gets synthetic result injected", async () => {
    const messages: Message[] = [
      userMsg("Do something"),
      toolUseMsg("tu_1", "file_read"),
      userMsg("Thanks"), // user text but no tool_result for tu_1
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        tool_use_id?: string;
        is_error?: boolean;
      }>;
    }>;

    // The second user message (after assistant) should now contain a synthetic tool_result
    const userAfterAssistant = sent[2];
    expect(userAfterAssistant.role).toBe("user");
    // Anthropic expects tool_result blocks to start the immediate next user message.
    expect(userAfterAssistant.content[0].type).toBe("tool_result");
    const toolResults = userAfterAssistant.content.filter(
      (b) => b.type === "tool_result",
    );
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe("tu_1");
    expect(toolResults[0].is_error).toBe(true);
  });

  test("tool_use at end of messages gets synthetic user message appended", async () => {
    const messages: Message[] = [
      userMsg("Read file"),
      toolUseMsg("tu_end", "file_read"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;

    // A synthetic user message should have been appended
    expect(sent).toHaveLength(3);
    expect(sent[2].role).toBe("user");
    const toolResults = sent[2].content.filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe("tu_end");
  });

  test("tool_use with matching tool_result passes through unchanged", async () => {
    const messages: Message[] = [
      userMsg("Read file"),
      toolUseMsg("tu_ok", "file_read"),
      toolResultMsg("tu_ok", "file contents"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;

    // No synthetic messages or blocks added
    expect(sent).toHaveLength(3);
    const toolResults = sent[2].content.filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe("tu_ok");
  });

  test("reconstructs collapsed assistant/tool_result/user timeline before sending", async () => {
    const messages: Message[] = [
      userMsg("Read files"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "Working on it." },
          { type: "tool_use", id: "tu_a", name: "file_read", input: {} },
          { type: "tool_use", id: "tu_b", name: "bash", input: {} },
          { type: "text", text: "One moment." },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<workspace>\nRoot: /sandbox\n</workspace>",
          },
          {
            type: "tool_result",
            tool_use_id: "tu_b",
            content: "result B",
            is_error: false,
          },
          { type: "text", text: "continue please" },
          {
            type: "tool_result",
            tool_use_id: "tu_a",
            content: "result A",
            is_error: false,
          },
        ],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string; text?: string }>;
    }>;

    // Input had 3 messages, but the collapsed history shape should be expanded:
    // user, assistant(tool_use...), user(tool_results), assistant(carryover text), user(remaining text)
    expect(sent).toHaveLength(5);

    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content.map((b) => b.type)).toEqual([
      "text",
      "tool_use",
      "tool_use",
    ]);

    expect(sent[2].role).toBe("user");
    expect(sent[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_a",
    });
    expect(sent[2].content[1]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_b",
    });
    expect(sent[2].content).toHaveLength(2);

    expect(sent[3].role).toBe("assistant");
    expect(sent[3].content.map((b) => b.type)).toEqual(["text"]);

    expect(sent[4].role).toBe("user");
    expect(sent[4].content.map((b) => b.type)).toEqual(["text", "text"]);
  });

  test("multiple tool_use with partial results gets missing ones filled", async () => {
    const messages: Message[] = [
      userMsg("Do things"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_a", name: "file_read", input: {} },
          { type: "tool_use", id: "tu_b", name: "file_write", input: {} },
          { type: "tool_use", id: "tu_c", name: "bash", input: {} },
        ],
      },
      // Only tu_a has a result
      toolResultMsg("tu_a", "result A"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        tool_use_id?: string;
        is_error?: boolean;
      }>;
    }>;

    const userAfterAssistant = sent[2];
    const toolResults = userAfterAssistant.content.filter(
      (b) => b.type === "tool_result",
    );
    expect(toolResults).toHaveLength(3);
    expect(userAfterAssistant.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_a",
    });
    expect(userAfterAssistant.content[1]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_b",
    });
    expect(userAfterAssistant.content[2]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_c",
    });

    // tu_a: original result
    expect(
      toolResults.find((r) => r.tool_use_id === "tu_a")!.is_error,
    ).toBeFalsy();
    // tu_b and tu_c: synthetic
    expect(toolResults.find((r) => r.tool_use_id === "tu_b")!.is_error).toBe(
      true,
    );
    expect(toolResults.find((r) => r.tool_use_id === "tu_c")!.is_error).toBe(
      true,
    );
  });

  test("consecutive assistant messages with tool_use each get synthetic results", async () => {
    const messages: Message[] = [
      userMsg("Start"),
      toolUseMsg("tu_1", "file_read"),
      // missing tool_result for tu_1, then another assistant
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_2", name: "bash", input: {} }],
      },
      userMsg("Done"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;

    // Should be: user, assistant(tu_1), synthetic_user(tu_1), assistant(tu_2), user_with_synthetic(tu_2)
    expect(sent).toHaveLength(5);
    expect(sent[0].role).toBe("user");
    expect(sent[1].role).toBe("assistant");
    expect(sent[2].role).toBe("user");
    expect(
      sent[2].content.some(
        (b) => b.type === "tool_result" && b.tool_use_id === "tu_1",
      ),
    ).toBe(true);
    expect(sent[3].role).toBe("assistant");
    expect(sent[4].role).toBe("user");
    expect(
      sent[4].content.some(
        (b) => b.type === "tool_result" && b.tool_use_id === "tu_2",
      ),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // ensureToolPairing — server_tool_use / web_search_tool_result pairing
  // -----------------------------------------------------------------------

  test("orphaned server_tool_use gets synthetic web_search_tool_result injected", async () => {
    // When stream is interrupted, server_tool_use may be stored without its
    // paired web_search_tool_result. repairOrphanedServerToolUse should inject
    // a synthetic error web_search_tool_result after the orphan so the model
    // knows the search failed (rather than silently returning zero results).
    const messages: Message[] = [
      userMsg("Search for something"),
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_abc123",
            name: "web_search",
            input: { query: "test" },
          },
        ],
      },
      userMsg("Thanks"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        tool_use_id?: string;
        content?: unknown;
      }>;
    }>;

    // server_tool_use stays in the assistant message with synthetic result appended
    expect(sent).toHaveLength(3);
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content[0].type).toBe("server_tool_use");
    expect(sent[1].content[1].type).toBe("web_search_tool_result");
    expect(sent[1].content[1].tool_use_id).toBe("srvtoolu_abc123");
    expect(sent[1].content[1].content).toEqual({
      type: "web_search_tool_result_error",
      error_code: "unavailable",
    });
    expect(sent[2].role).toBe("user");
    expect(sent[2].content[0].type).toBe("text");
  });

  test("orphaned server_tool_use at end of messages gets synthetic result (no synthetic user append)", async () => {
    // Orphaned server_tool_use at the end should get a synthetic
    // web_search_tool_result but no synthetic user message.
    const messages: Message[] = [
      userMsg("Search something"),
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_end",
            name: "web_search",
            input: { query: "test" },
          },
        ],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;

    // Original 2 messages, with synthetic result injected in assistant message
    expect(sent).toHaveLength(2);
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content[0].type).toBe("server_tool_use");
    expect(sent[1].content[1].type).toBe("web_search_tool_result");
    expect(sent[1].content[1].tool_use_id).toBe("srvtoolu_end");
  });

  test("server_tool_use with matching web_search_tool_result passes through unchanged", async () => {
    const messages: Message[] = [
      userMsg("Search something"),
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_ok",
            name: "web_search",
            input: { query: "test" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_ok",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com",
                title: "Example",
                encrypted_content: "enc_abc",
              },
            ],
          },
        ],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;

    // No synthetic messages or blocks added
    expect(sent).toHaveLength(3);
    const resultBlocks = sent[2].content.filter(
      (b) => b.type === "web_search_tool_result",
    );
    expect(resultBlocks).toHaveLength(1);
    expect(resultBlocks[0].tool_use_id).toBe("srvtoolu_ok");
  });

  test("server_tool_use + web_search_tool_result + tool_use in same assistant message stays intact", async () => {
    // This is the core bug scenario: Anthropic returns server_tool_use,
    // web_search_tool_result, text, and tool_use all in one assistant message.
    // The server pair must stay together in the assistant message.
    const messages: Message[] = [
      userMsg("Search and fetch"),
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_search",
            name: "web_search",
            input: { query: "test" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_search",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com",
                title: "Example",
                encrypted_content: "enc_123",
              },
            ],
          },
          { type: "text", text: "Based on the search results..." },
          {
            type: "tool_use",
            id: "tu_fetch",
            name: "fetch_url",
            input: { url: "https://example.com" },
          },
        ],
      },
      toolResultMsg("tu_fetch", "page content here"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        id?: string;
        tool_use_id?: string;
      }>;
    }>;

    // The server_tool_use pair (server_tool_use + web_search_tool_result) should
    // be in the leading portion of the assistant message, before tool_use.
    // splitAssistantForToolPairing: leading=[server_tool_use, web_search_tool_result, text],
    // toolUseBlocks=[tool_use], carryover=[]
    const assistantMsg = sent[1];
    expect(assistantMsg.role).toBe("assistant");
    const blockTypes = assistantMsg.content.map((b) => b.type);
    expect(blockTypes).toContain("server_tool_use");
    expect(blockTypes).toContain("web_search_tool_result");
    expect(blockTypes).toContain("tool_use");

    // The tool_result for the client-side tool_use should be in the user message
    const userMsg2 = sent[2];
    expect(userMsg2.role).toBe("user");
    expect(
      userMsg2.content.some(
        (b) => b.type === "tool_result" && b.tool_use_id === "tu_fetch",
      ),
    ).toBe(true);

    // No synthetic web_search_tool_result injected anywhere
    const allBlocks = sent.flatMap((m) => m.content);
    const webSearchResults = allBlocks.filter(
      (b) => b.type === "web_search_tool_result",
    );
    expect(webSearchResults).toHaveLength(1); // only the original one
    expect(webSearchResults[0].tool_use_id).toBe("srvtoolu_search");
  });

  test("mixed tool_use and server_tool_use — only client-side tool_use gets pairing, server tools pass through", async () => {
    const messages: Message[] = [
      userMsg("Do things"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_a", name: "file_read", input: {} },
          {
            type: "server_tool_use",
            id: "srvtoolu_b",
            name: "web_search",
            input: { query: "test" },
          },
        ],
      },
      // Only tu_a has a result — server_tool_use doesn't need one in the user message
      toolResultMsg("tu_a", "result A"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        tool_use_id?: string;
        id?: string;
      }>;
    }>;

    // Assistant message should have tool_use in paired portion, server_tool_use in carryover
    // ensureToolPairing splits: paired = [tool_use(tu_a)], carryover = [server_tool_use(srvtoolu_b)]
    // Result: assistant(tool_use) → user(tool_result) → assistant(server_tool_use) → user(synthetic_continuation)
    const assistantMsg = sent[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content[0].type).toBe("tool_use");

    const userAfterAssistant = sent[2];
    expect(userAfterAssistant.role).toBe("user");
    // Only tool_result for tu_a — no synthetic web_search_tool_result
    expect(userAfterAssistant.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_a",
    });

    // server_tool_use preserved in a carryover assistant message with synthetic result
    const carryoverAssistant = sent[3];
    expect(carryoverAssistant.role).toBe("assistant");
    expect(carryoverAssistant.content[0].type).toBe("server_tool_use");
    expect(carryoverAssistant.content[1].type).toBe("web_search_tool_result");
    expect(carryoverAssistant.content[1].tool_use_id).toBe("srvtoolu_b");
  });

  test("orphaned server_tool_use from interrupted stream gets repaired in multi-turn conversation", async () => {
    // Reproduces the real bug: web_search stream interrupted, server_tool_use
    // stored without web_search_tool_result, next user message triggers replay
    // which would cause a 400 error without the repair.
    const messages: Message[] = [
      userMsg("fetch this page and search the web"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll do both." },
          {
            type: "tool_use",
            id: "tu_fetch",
            name: "web_fetch",
            input: { url: "https://example.com" },
          },
          {
            type: "server_tool_use",
            id: "srvtoolu_interrupted",
            name: "web_search",
            input: { query: "test" },
          },
          // NOTE: no web_search_tool_result — stream was interrupted
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_fetch",
            content: "page content here",
            is_error: false,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "The fetch worked but search failed." },
        ],
      },
      userMsg("try again"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        id?: string;
        tool_use_id?: string;
        content?: unknown;
      }>;
    }>;

    // The orphaned server_tool_use should have a synthetic web_search_tool_result
    // injected in the assistant message, preventing the 400 error.
    const allBlocks = sent.flatMap((m) => m.content);
    const syntheticResults = allBlocks.filter(
      (b) =>
        b.type === "web_search_tool_result" &&
        b.tool_use_id === "srvtoolu_interrupted",
    );
    expect(syntheticResults).toHaveLength(1);
    expect(syntheticResults[0].content).toEqual({
      type: "web_search_tool_result_error",
      error_code: "unavailable",
    });
  });

  test("paired server_tool_use is not modified by repair", async () => {
    // When server_tool_use has its matching web_search_tool_result,
    // repairOrphanedServerToolUse should not inject anything.
    const messages: Message[] = [
      userMsg("search"),
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_paired",
            name: "web_search",
            input: { query: "test" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_paired",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com",
                title: "Example",
                encrypted_content: "enc",
              },
            ],
          },
          { type: "text", text: "Found results." },
        ],
      },
      userMsg("thanks"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;

    // Only 1 web_search_tool_result — the original, no synthetic one added
    const allBlocks = sent.flatMap((m) => m.content);
    const wsResults = allBlocks.filter(
      (b) => b.type === "web_search_tool_result",
    );
    expect(wsResults).toHaveLength(1);
    expect(wsResults[0].tool_use_id).toBe("srvtoolu_paired");
  });

  test("assistant message with only unknown blocks gets placeholder text", async () => {
    const messages: Message[] = [
      userMsg("Start"),
      // Assistant message with only ui_surface (unknown type) — will be filtered
      {
        role: "assistant",
        content: [
          { type: "ui_surface" as "text", text: "this will be filtered" },
        ],
      },
      userMsg("Continue"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    // Should preserve alternation: user, assistant (with placeholder), user
    expect(sent).toHaveLength(3);
    expect(sent[0].role).toBe("user");
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content).toHaveLength(1);
    expect(sent[1].content[0].type).toBe("text");
    expect(sent[1].content[0].text).toBe(PLACEHOLDER_BLOCKS_OMITTED);
    expect(sent[2].role).toBe("user");
  });

  test("assistant message with mix of known and unknown blocks keeps known blocks", async () => {
    const messages: Message[] = [
      userMsg("Start"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "Valid text" },
          { type: "ui_surface" as "text", text: "this will be filtered" },
          { type: "text", text: "More valid text" },
        ],
      },
      userMsg("Continue"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    expect(sent).toHaveLength(3);
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content).toHaveLength(2);
    expect(sent[1].content[0].text).toBe("Valid text");
    expect(sent[1].content[1].text).toBe("More valid text");
  });

  test("assistant message with only whitespace text gets placeholder to preserve alternation", async () => {
    const messages: Message[] = [
      userMsg("Start"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "   " },
          { type: "text", text: "\n\t" },
        ],
      },
      userMsg("Continue"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    // Whitespace-only assistant messages between user messages must be preserved
    // with a placeholder to maintain Anthropic's strict role alternation
    expect(sent).toHaveLength(3);
    expect(sent[0].role).toBe("user");
    expect(sent[0].content[0].text).toBe("Start");
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content).toHaveLength(1);
    expect(sent[1].content[0].type).toBe("text");
    expect(sent[1].content[0].text).toBe(PLACEHOLDER_EMPTY_TURN);
    expect(sent[2].role).toBe("user");
    expect(sent[2].content[0].text).toBe("Continue");
  });

  test("unknown-blocks-only assistant followed by empty user does not produce consecutive same-role messages", async () => {
    // Same edge case as the empty-assistant test below, but triggered by an
    // assistant turn whose blocks are all unknown (e.g. ui_surface). The turn
    // becomes a [internal blocks omitted] placeholder which must also be
    // removed when adjacent to a real assistant message.
    const messages: Message[] = [
      userMsg("Start"),
      {
        role: "assistant",
        content: [{ type: "ui_surface" as "text", text: "invisible" }], // unknown → placeholder
      },
      {
        role: "user",
        content: [{ type: "text", text: "  \n  " }], // whitespace-only → empty after filtering
      },
      assistantMsg("Real response"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    // Verify strict role alternation: no two adjacent messages share the same role
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i].role).not.toBe(sent[i - 1].role);
    }
  });

  test("empty assistant followed by empty user does not produce consecutive same-role messages", async () => {
    // Edge case: an empty assistant turn gets a placeholder injected, but if
    // the following user turn also filters to empty (e.g. whitespace-only),
    // the user turn is dropped and the placeholder ends up adjacent to the
    // next real assistant turn — producing consecutive assistant roles.
    const messages: Message[] = [
      userMsg("Start"),
      {
        role: "assistant",
        content: [{ type: "text", text: "   " }], // whitespace-only → empty after filtering
      },
      {
        role: "user",
        content: [{ type: "text", text: "  \n  " }], // whitespace-only → empty after filtering
      },
      assistantMsg("Real response"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    // Verify strict role alternation: no two adjacent messages share the same role
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i].role).not.toBe(sent[i - 1].role);
    }
  });

  // -----------------------------------------------------------------------
  // Workspace context injection + cache control
  // -----------------------------------------------------------------------

  test("carryover with tool_result-only user turn emits synthetic user message", async () => {
    // This tests the fix for consecutive assistant messages when:
    // - assistant has both tool_use blocks and trailing non-tool blocks (carryover)
    // - following user message contains ONLY tool_result blocks (no other content)
    const messages: Message[] = [
      userMsg("Read file"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "file_read", input: {} },
          { type: "text", text: "Checking the file now." }, // carryover content
        ],
      },
      {
        role: "user",
        content: [
          // ONLY tool_result, no other content
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "file contents",
            is_error: false,
          },
        ],
      },
      assistantMsg("Next response"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string; tool_use_id?: string }>;
    }>;

    // Expected structure:
    // 1. user(Read file)
    // 2. assistant(tool_use)
    // 3. user(tool_result)
    // 4. assistant(Checking the file now.)
    // 5. user(<synthetic_continuation __injected />)  <-- synthetic user message to maintain alternation
    // 6. assistant(Next response)
    expect(sent).toHaveLength(6);
    expect(sent[0].role).toBe("user");
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content[0].type).toBe("tool_use");
    expect(sent[2].role).toBe("user");
    expect(sent[2].content[0].type).toBe("tool_result");
    expect(sent[3].role).toBe("assistant");
    expect(sent[3].content[0].type).toBe("text");
    expect(sent[3].content[0].text).toBe("Checking the file now.");
    expect(sent[4].role).toBe("user");
    expect(sent[4].content[0].type).toBe("text");
    expect(sent[4].content[0].text).toBe(
      "<synthetic_continuation __injected />",
    );
    expect(sent[5].role).toBe("assistant");
    expect(sent[5].content[0].text).toBe("Next response");
  });

  test("carryover with tool_result-only user turn skips synthetic when next message is user", async () => {
    // When the user turn after the consumed pair is already a user message,
    // the synthetic continuation is unnecessary — the next user message
    // naturally maintains alternation after the carryover assistant message.
    const messages: Message[] = [
      userMsg("Read file"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "file_read", input: {} },
          { type: "text", text: "Checking the file now." }, // carryover content
        ],
      },
      {
        role: "user",
        content: [
          // ONLY tool_result, no other content
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "file contents",
            is_error: false,
          },
        ],
      },
      userMsg("Follow-up question"), // next message is user — no synthetic needed
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string; tool_use_id?: string }>;
    }>;

    // Expected structure:
    // 1. user(Read file)
    // 2. assistant(tool_use)
    // 3. user(tool_result)
    // 4. assistant(Checking the file now.)
    // 5. user(Follow-up question)  <-- real user message, NO synthetic continuation
    expect(sent).toHaveLength(5);
    expect(sent[0].role).toBe("user");
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content[0].type).toBe("tool_use");
    expect(sent[2].role).toBe("user");
    expect(sent[2].content[0].type).toBe("tool_result");
    expect(sent[3].role).toBe("assistant");
    expect(sent[3].content[0].text).toBe("Checking the file now.");
    expect(sent[4].role).toBe("user");
    expect(sent[4].content[0].text).toBe("Follow-up question");
  });

  test("multi-turn with workspace injection: only last user message gets 1h cache", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<workspace>\nRoot: /sandbox\nDirectories: src\n</workspace>",
          },
          { type: "text", text: "Turn 1" },
        ],
      },
      assistantMsg("Response 1"),
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<workspace>\nRoot: /sandbox\nDirectories: src, lib\n</workspace>",
          },
          { type: "text", text: "Turn 2" },
        ],
      },
      assistantMsg("Response 2"),
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<workspace>\nRoot: /sandbox\nDirectories: src, lib, docs\n</workspace>",
          },
          { type: "text", text: "Turn 3" },
        ],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const userMsgs = sent.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(3);

    // Earlier user messages: no cache_control
    for (const user of userMsgs.slice(0, -1)) {
      for (const block of user.content) {
        expect(block.cache_control).toBeUndefined();
      }
    }

    // Last user message (turn 3): 1h cache on last block only
    const lastUser = userMsgs[userMsgs.length - 1];
    expect(lastUser.content[0].cache_control).toBeUndefined();
    expect(lastUser.content[1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    // No top-level cache_control — breakpoints are set directly on blocks
    expect(
      (lastStreamParams as Record<string, unknown>).cache_control,
    ).toBeUndefined();
  });

  test("tool loop: turn-starting user message gets 1h cache, last tool_result gets 5m advancing tail", async () => {
    const messages: Message[] = [
      userMsg("Read the config file"),
      toolUseMsg("tu_1", "file_read"),
      toolResultMsg("tu_1", "config contents here"),
      toolUseMsg("tu_2", "file_read"),
      toolResultMsg("tu_2", "more contents"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text?: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;

    // First message is the turn-starting user text — gets 1h cache
    expect(sent[0].role).toBe("user");
    expect(sent[0].content[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    // Non-last tool result messages do NOT get cache_control
    const toolResultMsgs = sent.filter(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.every(
          (b) => typeof b !== "string" && b.type === "tool_result",
        ),
    );
    expect(toolResultMsgs.length).toBeGreaterThan(0);
    for (const tr of toolResultMsgs.slice(0, -1)) {
      for (const block of tr.content) {
        expect(block.cache_control).toBeUndefined();
      }
    }

    // Last message gets 5m advancing tail cache on its last block
    const lastMsg = sent[sent.length - 1];
    const lastBlock = lastMsg.content[lastMsg.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  // -----------------------------------------------------------------------
  // is_error + contentBlocks — non-text blocks must be stripped
  // -----------------------------------------------------------------------

  test("is_error tool_result strips non-text contentBlocks (images)", async () => {
    const messages: Message[] = [
      userMsg("Do something"),
      toolUseMsg("tu_img", "file_read"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_img",
            content: "Error: file not found",
            is_error: true,
            contentBlocks: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBOR",
                },
              },
              { type: "text", text: "extra error detail" },
            ],
          },
        ],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        tool_use_id?: string;
        is_error?: boolean;
        content?: unknown;
      }>;
    }>;

    const toolResult = sent[2].content.find(
      (b) => b.type === "tool_result" && b.tool_use_id === "tu_img",
    )!;
    expect(toolResult.is_error).toBe(true);

    // Content should be an array with only text blocks (no images)
    const parts = toolResult.content as Array<{ type: string }>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.every((p) => p.type === "text")).toBe(true);
    // Original text + the extra text contentBlock
    expect(parts).toHaveLength(2);
  });

  test("is_error tool_result with only image contentBlocks falls back to text-only", async () => {
    const messages: Message[] = [
      userMsg("Do something"),
      toolUseMsg("tu_img2", "file_read"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_img2",
            content: "Error: file not found",
            is_error: true,
            contentBlocks: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBOR",
                },
              },
            ],
          },
        ],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        tool_use_id?: string;
        is_error?: boolean;
        content?: unknown;
      }>;
    }>;

    const toolResult = sent[2].content.find(
      (b) => b.type === "tool_result" && b.tool_use_id === "tu_img2",
    )!;
    expect(toolResult.is_error).toBe(true);

    // All images stripped → no usable blocks → falls back to text-only content
    expect(toolResult.content).toBe("Error: file not found");
  });

  test("non-error tool_result preserves image contentBlocks", async () => {
    const messages: Message[] = [
      userMsg("Do something"),
      toolUseMsg("tu_img3", "file_read"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_img3",
            content: "Success",
            is_error: false,
            contentBlocks: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBOR",
                },
              },
            ],
          },
        ],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        tool_use_id?: string;
        is_error?: boolean;
        content?: unknown;
      }>;
    }>;

    const toolResult = sent[2].content.find(
      (b) => b.type === "tool_result" && b.tool_use_id === "tu_img3",
    )!;
    expect(toolResult.is_error).toBe(false);

    // Non-error: images should be preserved in the content array
    const parts = toolResult.content as Array<{ type: string }>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.some((p) => p.type === "image")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — Managed Proxy Fallback
// ---------------------------------------------------------------------------

describe("AnthropicProvider — Managed Proxy Fallback", () => {
  beforeEach(() => {
    lastStreamParams = null;
    _lastStreamOptions = null;
    lastConstructorArgs = null;
  });

  test("constructor passes baseURL to Anthropic SDK when provided", () => {
    new AnthropicProvider("managed-key", "claude-sonnet-4-6", {
      baseURL: "https://platform.example.com/v1/runtime-proxy/anthropic",
    });

    expect(lastConstructorArgs).not.toBeNull();
    expect(lastConstructorArgs!.apiKey).toBe("managed-key");
    expect(lastConstructorArgs!.baseURL).toBe(
      "https://platform.example.com/v1/runtime-proxy/anthropic",
    );
  });

  test("constructor does not set baseURL when option is omitted", () => {
    new AnthropicProvider("sk-ant-user-key", "claude-sonnet-4-6");

    expect(lastConstructorArgs).not.toBeNull();
    expect(lastConstructorArgs!.apiKey).toBe("sk-ant-user-key");
    expect(lastConstructorArgs!.baseURL).toBeUndefined();
  });

  test("managed mode provider preserves tool-pairing behavior", async () => {
    const provider = new AnthropicProvider("managed-key", "claude-sonnet-4-6", {
      baseURL: "https://platform.example.com/v1/runtime-proxy/anthropic",
    });

    const messages: Message[] = [
      userMsg("Read file"),
      toolUseMsg("tu_1", "file_read"),
      toolResultMsg("tu_1", "file contents"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;

    expect(sent).toHaveLength(3);
    const toolResults = sent[2].content.filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe("tu_1");
  });

  test("managed mode provider preserves cache-control behavior", async () => {
    const provider = new AnthropicProvider("managed-key", "claude-sonnet-4-6", {
      baseURL: "https://platform.example.com/v1/runtime-proxy/anthropic",
    });

    await provider.sendMessage(
      [userMsg("Hi")],
      sampleTools,
      "You are helpful.",
    );

    // System prompt cache control
    const system = lastStreamParams!.system as Array<{
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // Last tool cache control
    const tools = lastStreamParams!.tools as Array<{
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(tools[tools.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — Orphaned UTF-16 surrogate sanitization
// ---------------------------------------------------------------------------

describe("AnthropicProvider — surrogate sanitization", () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    lastStreamParams = null;
    provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");
  });

  test("strips orphaned high surrogate from a tool result before sending", async () => {
    // An orphaned high surrogate — the exact shape that triggers Anthropic's
    // "no low surrogate in string" 400. The mock's JSON.parse(JSON.stringify)
    // on line ~44 would throw if sanitization didn't happen.
    const LONE_HIGH = "\uD83C";
    const messages: Message[] = [
      toolUseMsg("tu1", "bash"),
      toolResultMsg("tu1", `shell output ${LONE_HIGH} more output`),
      userMsg("what happened?"),
    ];

    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; content?: string; text?: string }>;
    }>;
    // Find the tool_result block in the captured payload and assert no orphans.
    const toolResult = sent
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.content).toBeDefined();
    const content = toolResult!.content as string;
    for (let i = 0; i < content.length; i++) {
      const code = content.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = i + 1 < content.length ? content.charCodeAt(i + 1) : 0;
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i++;
      } else {
        expect(code < 0xdc00 || code > 0xdfff).toBe(true);
      }
    }
  });

  test("clean payloads are not copied unnecessarily", async () => {
    // When there are no orphans, the sanitizer should be a no-op. We can't
    // easily assert reference equality through the mock boundary (the mock
    // JSON-round-trips params for capture), but we can at least confirm the
    // call succeeds without error on ordinary payloads containing valid
    // surrogate pairs (emoji).
    const EMOJI = "\uD83C\uDF89";
    await provider.sendMessage([userMsg(`hello ${EMOJI} world`)]);
    const sent = lastStreamParams!.messages as Array<{
      content: Array<{ text?: string }>;
    }>;
    expect(sent[0].content[0].text).toContain(EMOJI);
  });
});

// ---------------------------------------------------------------------------
// Haiku model gating
// ---------------------------------------------------------------------------

describe("AnthropicProvider — Haiku Model Gating", () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    lastStreamParams = null;
    _lastStreamOptions = null;
    lastConstructorArgs = null;
    provider = new AnthropicProvider(
      "sk-ant-test",
      "claude-haiku-4-5-20251001",
    );
  });

  test("max_tokens defaults to 8192 for Haiku", async () => {
    await provider.sendMessage([userMsg("Hi")], undefined, "You are helpful.");

    expect(lastStreamParams!.max_tokens).toBe(8192);
  });

  test("caller max_tokens is clamped to 8192 for Haiku", async () => {
    await provider.sendMessage([userMsg("Hi")], undefined, "You are helpful.", {
      config: { max_tokens: 64000 },
    });

    expect(lastStreamParams!.max_tokens).toBe(8192);
  });

  test("caller max_tokens below 8192 is preserved for Haiku", async () => {
    await provider.sendMessage([userMsg("Hi")], undefined, "You are helpful.", {
      config: { max_tokens: 128 },
    });

    expect(lastStreamParams!.max_tokens).toBe(128);
  });

  test("non-Haiku provider respects caller max_tokens without clamping", async () => {
    const sonnetProvider = new AnthropicProvider(
      "sk-ant-test",
      "claude-sonnet-4-6",
    );
    await sonnetProvider.sendMessage(
      [userMsg("Hi")],
      undefined,
      "You are helpful.",
      { config: { max_tokens: 200 } },
    );

    expect(lastStreamParams!.max_tokens).toBe(200);
  });

  test("cache_control omits ttl for Haiku", async () => {
    await provider.sendMessage([userMsg("Hi")], undefined, "You are helpful.");

    const system = lastStreamParams!.system as Array<{
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[0].cache_control).not.toHaveProperty("ttl");
  });

  test("betas array is empty for Haiku (no extended cache TTL or 1M context)", async () => {
    await provider.sendMessage([userMsg("Hi")], undefined, "You are helpful.");

    // When betas is empty, the non-beta stream path is used, so no betas
    // field should appear in lastStreamParams.
    expect(lastStreamParams!.betas).toBeUndefined();
  });

  test("effort is stripped for Haiku even when provided in config", async () => {
    await provider.sendMessage([userMsg("Hi")], undefined, "You are helpful.", {
      config: { effort: "high" },
    });

    expect(lastStreamParams!.output_config).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OpenRouter routing Anthropic models through the Messages API
// ---------------------------------------------------------------------------

describe("OpenRouterProvider — Anthropic dispatch", () => {
  beforeEach(() => {
    lastStreamParams = null;
    _lastStreamOptions = null;
    lastConstructorArgs = null;
  });

  test("anthropic/ models are routed to Anthropic Messages API with Bearer auth", async () => {
    const { OpenRouterProvider } = await import(
      "../providers/openrouter/client.js"
    );
    const provider = new OpenRouterProvider(
      "or-key",
      "anthropic/claude-sonnet-4.6",
    );
    await provider.sendMessage([userMsg("hi")], undefined, "You are helpful.");

    expect(lastConstructorArgs).toMatchObject({
      apiKey: null,
      authToken: "or-key",
      baseURL: "https://openrouter.ai/api/v1/anthropic",
    });
    expect(lastStreamParams).toBeTruthy();
    expect(lastStreamParams!.model).toBe("anthropic/claude-sonnet-4.6");
  });

  test("custom baseURL is suffixed with /anthropic for Messages API", async () => {
    const { OpenRouterProvider } = await import(
      "../providers/openrouter/client.js"
    );
    const provider = new OpenRouterProvider(
      "ast-key",
      "anthropic/claude-opus-4.6",
      { baseURL: "https://platform.example.com/v1/runtime-proxy/openrouter" },
    );
    await provider.sendMessage([userMsg("hi")]);

    expect(lastConstructorArgs).toMatchObject({
      baseURL:
        "https://platform.example.com/v1/runtime-proxy/openrouter/anthropic",
    });
  });

  test("thinking config flows through to Anthropic Messages API natively", async () => {
    const { OpenRouterProvider } = await import(
      "../providers/openrouter/client.js"
    );
    const provider = new OpenRouterProvider(
      "or-key",
      "anthropic/claude-sonnet-4.6",
    );
    await provider.sendMessage([userMsg("hi")], undefined, undefined, {
      config: { thinking: { type: "adaptive" } },
    });

    expect(lastStreamParams!.thinking).toEqual({ type: "adaptive" });
    // The OpenAI-compat `reasoning` parameter must NOT be sent on the
    // native Messages API path.
    expect(lastStreamParams!.reasoning).toBeUndefined();
  });

  test("per-request model override routes based on the overridden model", async () => {
    const { OpenRouterProvider } = await import(
      "../providers/openrouter/client.js"
    );
    // Default model is non-Anthropic, but the request overrides with an
    // Anthropic model — dispatch must honour the request-level model.
    const provider = new OpenRouterProvider("or-key", "x-ai/grok-4");
    await provider.sendMessage([userMsg("hi")], undefined, undefined, {
      config: { model: "anthropic/claude-haiku-4.5" },
    });

    expect(lastStreamParams).toBeTruthy();
    expect(lastStreamParams!.model).toBe("anthropic/claude-haiku-4.5");
  });
});
