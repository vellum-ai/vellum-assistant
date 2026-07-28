import { beforeEach, describe, expect, mock, test } from "bun:test";

import { RetryProvider } from "../providers/retry.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderEvent,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { ProviderError } from "../util/errors.js";

// ---------------------------------------------------------------------------
// Mock openai module — must be before importing the provider
// ---------------------------------------------------------------------------

interface FakeChunk {
  choices: Array<{
    delta: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      reasoning_details?: Array<{
        type?: string;
        summary?: string | null;
        text?: string | null;
      }> | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  } | null;
  model: string;
}

let fakeChunks: FakeChunk[] = [];
let lastCreateParams: Record<string, unknown> | null = null;
let lastCreateOptions: Record<string, unknown> | null = null;
let lastConstructorOptions: Record<string, unknown> | null = null;
let shouldThrow: Error | null = null;
const DEFAULT_SDK_TIMEOUT_MS = 1_860_000;

// Each provider installs a `fetch` wrapper to capture raw error bodies, so the
// constructor options carry a `fetch` function; assert the meaningful options
// via objectContaining and confirm `fetch` is wired.
function expectOpenAIConstructorOptions(
  expected: Record<string, unknown>,
): void {
  expect(lastConstructorOptions).toEqual(expect.objectContaining(expected));
  expect(typeof lastConstructorOptions?.fetch).toBe("function");
}

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

// Simulate OpenAI.APIError
class FakeAPIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "APIError";
  }
}

mock.module("openai", () => ({
  default: class MockOpenAI {
    static APIError = FakeAPIError;
    constructor(opts: Record<string, unknown>) {
      lastConstructorOptions = opts;
    }
    chat = {
      completions: {
        create: async (
          params: Record<string, unknown>,
          options?: Record<string, unknown>,
        ) => {
          lastCreateParams = params;
          lastCreateOptions = options ?? null;
          if (shouldThrow) throw shouldThrow;

          return {
            [Symbol.asyncIterator]: async function* () {
              for (const chunk of fakeChunks) {
                yield chunk;
              }
            },
          };
        },
      },
    };
  },
}));

// Import after mocking
import { FireworksProvider } from "../providers/fireworks/client.js";
import { MinimaxProvider } from "../providers/minimax/client.js";
import { OllamaProvider } from "../providers/ollama/client.js";
import {
  EMPTY_ASSISTANT_TURN_PLACEHOLDER,
  OpenAIChatCompletionsProvider,
} from "../providers/openai/chat-completions-provider.js";
import { OpenAIProvider } from "../providers/openai/client.js";
import { OpenRouterProvider } from "../providers/openrouter/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textChunk(content: string, finish: string | null = null): FakeChunk {
  return {
    choices: [{ delta: { content }, finish_reason: finish }],
    usage: null,
    model: "gpt-5.2",
  };
}

function toolCallChunks(
  calls: Array<{ id: string; name: string; args: string }>,
): FakeChunk[] {
  const chunks: FakeChunk[] = [];
  for (let i = 0; i < calls.length; i++) {
    // First chunk: id + name
    chunks.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: i,
                id: calls[i].id,
                type: "function",
                function: { name: calls[i].name },
              },
            ],
          },
          finish_reason: null,
        },
      ],
      usage: null,
      model: "gpt-5.2",
    });
    // Second chunk: arguments
    chunks.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: i,
                function: { arguments: calls[i].args },
              },
            ],
          },
          finish_reason: null,
        },
      ],
      usage: null,
      model: "gpt-5.2",
    });
  }
  return chunks;
}

function usageChunk(prompt: number, completion: number): FakeChunk {
  return {
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
    model: "gpt-5.2",
  };
}

function reasoningUsageChunk(
  prompt: number,
  completion: number,
  reasoning: number,
): FakeChunk {
  return {
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      completion_tokens_details: {
        reasoning_tokens: reasoning,
      },
    },
    model: "gpt-5.2",
  };
}

function cachedUsageChunk(
  prompt: number,
  completion: number,
  cached: number,
): FakeChunk {
  return {
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: {
        cached_tokens: cached,
      },
    },
    model: "gpt-5.2",
  };
}

function reasoningChunk(
  reasoning: string,
  finish: string | null = null,
): FakeChunk {
  return {
    choices: [
      { delta: { reasoning_content: reasoning }, finish_reason: finish },
    ],
    usage: null,
    model: "gpt-5.2",
  };
}

// OpenRouter spec uses `delta.reasoning` rather than `delta.reasoning_content`.
function openRouterReasoningChunk(
  reasoning: string,
  finish: string | null = null,
): FakeChunk {
  return {
    choices: [{ delta: { reasoning }, finish_reason: finish }],
    usage: null,
    model: "gpt-5.2",
  };
}

// OpenRouter's documented reasoning-summary shape: a `reasoning_details` array
// with entries tagged `reasoning.summary` / `reasoning.text` / `reasoning.encrypted`.
function reasoningDetailsChunk(
  details: Array<{ type?: string; summary?: string; text?: string }>,
  finish: string | null = null,
): FakeChunk {
  return {
    choices: [{ delta: { reasoning_details: details }, finish_reason: finish }],
    usage: null,
    model: "gpt-5.2",
  };
}

// ---------------------------------------------------------------------------
// Class extraction sanity checks
// ---------------------------------------------------------------------------

describe("OpenAIChatCompletionsProvider extraction", () => {
  test("OpenAIProvider is an alias for OpenAIChatCompletionsProvider", () => {
    expect(OpenAIProvider).toBe(OpenAIChatCompletionsProvider);
  });

  test("compatibility providers extend OpenAIChatCompletionsProvider", () => {
    lastConstructorOptions = null;

    const or = new OpenRouterProvider("or-key", "openai/gpt-4o");
    expect(or).toBeInstanceOf(OpenAIChatCompletionsProvider);

    const fw = new FireworksProvider(
      "fw-key",
      "accounts/fireworks/models/llama-v3p1-70b-instruct",
    );
    expect(fw).toBeInstanceOf(OpenAIChatCompletionsProvider);

    const ol = new OllamaProvider("llama3.2");
    expect(ol).toBeInstanceOf(OpenAIChatCompletionsProvider);
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAIProvider", () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    fakeChunks = [];
    lastCreateParams = null;
    lastCreateOptions = null;
    lastConstructorOptions = null;
    shouldThrow = null;
    provider = new OpenAIProvider("sk-test-key", "gpt-5.2");
  });

  test("supports OpenAI-compatible baseURL/provider metadata", () => {
    const compatible = new OpenAIProvider("sk-local", "llama3.2", {
      baseURL: "http://127.0.0.1:11434/v1",
      providerName: "ollama",
      providerLabel: "Ollama",
    });

    expect(compatible.name).toBe("ollama");
    expectOpenAIConstructorOptions({
      apiKey: "sk-local",
      baseURL: "http://127.0.0.1:11434/v1",
      timeout: DEFAULT_SDK_TIMEOUT_MS,
    });
  });

  test("ollama wrapper uses OpenAI-compatible defaults", () => {
    const previousBaseUrl = process.env.OLLAMA_BASE_URL;
    try {
      delete process.env.OLLAMA_BASE_URL;
      const ollama = new OllamaProvider("llama3.2");
      expect(ollama.name).toBe("ollama");
      expectOpenAIConstructorOptions({
        apiKey: "ollama",
        baseURL: "http://127.0.0.1:11434/v1",
        timeout: DEFAULT_SDK_TIMEOUT_MS,
      });
    } finally {
      if (previousBaseUrl !== undefined) {
        process.env.OLLAMA_BASE_URL = previousBaseUrl;
      } else {
        delete process.env.OLLAMA_BASE_URL;
      }
    }
  });

  test("ollama wrapper treats empty OLLAMA_BASE_URL as unset", () => {
    const previousBaseUrl = process.env.OLLAMA_BASE_URL;
    try {
      process.env.OLLAMA_BASE_URL = "   ";
      const ollama = new OllamaProvider("llama3.2");
      expect(ollama.name).toBe("ollama");
      expectOpenAIConstructorOptions({
        apiKey: "ollama",
        baseURL: "http://127.0.0.1:11434/v1",
        timeout: DEFAULT_SDK_TIMEOUT_MS,
      });
    } finally {
      if (previousBaseUrl !== undefined) {
        process.env.OLLAMA_BASE_URL = previousBaseUrl;
      } else {
        delete process.env.OLLAMA_BASE_URL;
      }
    }
  });

  // -----------------------------------------------------------------------
  // Basic text response
  // -----------------------------------------------------------------------
  test("returns text response from streaming chunks", async () => {
    fakeChunks = [textChunk("Hello"), textChunk(", world!"), usageChunk(10, 5)];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "Hello, world!" });
    expect(result.model).toBe("gpt-5.2");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.stopReason).toBe("stop");
  });

  // -----------------------------------------------------------------------
  // Streaming events
  // -----------------------------------------------------------------------
  test("fires text_delta events during streaming", async () => {
    fakeChunks = [textChunk("Hello"), textChunk(", world!"), usageChunk(10, 5)];

    const events: ProviderEvent[] = [];
    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      { onEvent: (e) => events.push(e) },
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text_delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "text_delta", text: ", world!" });
  });

  test("fires tool preview and argument progress events while tool calls stream", async () => {
    fakeChunks = [
      ...toolCallChunks([
        {
          id: "call_write",
          name: "app_create",
          args: '{"source_files":[{"path":"src/App.tsx","content":"hello"}]}',
        },
      ]),
      usageChunk(10, 15),
    ];

    const events: ProviderEvent[] = [];
    await provider.sendMessage([userMsg("Create an app")], {
      onEvent: (e) => events.push(e),
    });

    expect(events.slice(0, 2)).toEqual([
      {
        type: "tool_use_preview_start",
        toolUseId: "call_write",
        toolName: "app_create",
      },
      {
        type: "input_json_delta",
        toolUseId: "call_write",
        toolName: "app_create",
        accumulatedJson:
          '{"source_files":[{"path":"src/App.tsx","content":"hello"}]}',
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // Reasoning content (MiniMax / DeepSeek extension)
  // -----------------------------------------------------------------------
  test("parses reasoning_content into thinking block", async () => {
    fakeChunks = [
      reasoningChunk("Let me think..."),
      textChunk("The answer is 42."),
      usageChunk(10, 20),
    ];

    const result = await provider.sendMessage([userMsg("Hi")]);

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({
      type: "thinking",
      thinking: "Let me think...",
      signature: "",
    });
    expect(result.content[1]).toEqual({
      type: "text",
      text: "The answer is 42.",
    });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  test("fires thinking_delta events during streaming", async () => {
    fakeChunks = [
      reasoningChunk("Let me think..."),
      textChunk("The answer is 42."),
      usageChunk(10, 20),
    ];

    const events: ProviderEvent[] = [];
    await provider.sendMessage([userMsg("Hi")], {
      onEvent: (e) => events.push(e),
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "thinking_delta",
      thinking: "Let me think...",
    });
    expect(events[1]).toEqual({
      type: "text_delta",
      text: "The answer is 42.",
    });
  });

  test("reasoning + tool calls orders correctly (thinking → tool_use)", async () => {
    fakeChunks = [
      reasoningChunk("Planning..."),
      ...toolCallChunks([
        { id: "call_1", name: "file_read", args: '{"path":"/a"}' },
      ]),
      usageChunk(10, 30),
    ];

    const result = await provider.sendMessage([userMsg("Read /a")]);

    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe("thinking");
    expect(result.content[1].type).toBe("tool_use");
  });

  test("no thinking block when reasoning_content is absent", async () => {
    fakeChunks = [textChunk("Just text"), usageChunk(10, 5)];

    const result = await provider.sendMessage([userMsg("Hi")]);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  test("parses OpenRouter's `delta.reasoning` field into thinking block", async () => {
    fakeChunks = [
      openRouterReasoningChunk("Hmm, let me think..."),
      textChunk("Final answer."),
      usageChunk(10, 8),
    ];

    const events: ProviderEvent[] = [];
    const result = await provider.sendMessage([userMsg("Hi")], {
      onEvent: (e) => events.push(e),
    });

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({
      type: "thinking",
      thinking: "Hmm, let me think...",
      signature: "",
    });
    expect(result.content[1]).toEqual({ type: "text", text: "Final answer." });
    expect(events).toContainEqual({
      type: "thinking_delta",
      thinking: "Hmm, let me think...",
    });
  });

  test("parses OpenRouter `delta.reasoning_details` summary/text entries and skips encrypted", async () => {
    fakeChunks = [
      reasoningDetailsChunk([
        { type: "reasoning.summary", summary: "Plan step one. " },
        { type: "reasoning.encrypted", text: "ENCRYPTED_BLOB" },
        { type: "reasoning.text", text: "Detailed thought." },
      ]),
      textChunk("Done."),
      usageChunk(10, 8),
    ];

    const events: ProviderEvent[] = [];
    const result = await provider.sendMessage([userMsg("Hi")], {
      onEvent: (e) => events.push(e),
    });

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({
      type: "thinking",
      thinking: "Plan step one. Detailed thought.",
      signature: "",
    });
    expect(result.content[1]).toEqual({ type: "text", text: "Done." });
    expect(events).toContainEqual({
      type: "thinking_delta",
      thinking: "Plan step one. ",
    });
    expect(events).toContainEqual({
      type: "thinking_delta",
      thinking: "Detailed thought.",
    });
    // Encrypted blob must never surface as visible thinking.
    for (const e of events) {
      if (e.type === "thinking_delta") {
        expect(e.thinking).not.toContain("ENCRYPTED_BLOB");
      }
    }
  });

  // -----------------------------------------------------------------------
  // System prompt
  // -----------------------------------------------------------------------
  test("places system prompt as first message", async () => {
    fakeChunks = [textChunk("OK"), usageChunk(10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      { systemPrompt: "You are a helpful assistant." },
    );

    const messages = lastCreateParams!.messages as Array<
      Record<string, unknown>
    >;
    expect(messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
    expect(messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  // -----------------------------------------------------------------------
  // Tool definitions
  // -----------------------------------------------------------------------
  test("converts tool definitions to OpenAI function format", async () => {
    fakeChunks = [textChunk("OK"), usageChunk(10, 2)];

    const tools: ToolDefinition[] = [
      {
        name: "file_read",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Read /tmp/test" }] }],
      { tools: tools },
    );

    const sentTools = lastCreateParams!.tools as Array<Record<string, unknown>>;
    expect(sentTools).toHaveLength(1);
    expect(sentTools[0]).toEqual({
      type: "function",
      function: {
        name: "file_read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    });
  });

  // -----------------------------------------------------------------------
  // Tool call response
  // -----------------------------------------------------------------------
  test("parses tool calls from streaming chunks", async () => {
    fakeChunks = [
      ...toolCallChunks([
        { id: "call_abc", name: "file_read", args: '{"path":"/tmp/test"}' },
      ]),
      usageChunk(10, 15),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Read /tmp/test" }] },
    ]);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "tool_use",
      id: "call_abc",
      name: "file_read",
      input: { path: "/tmp/test" },
    });
    expect(result.stopReason).toBe("stop");
  });

  // -----------------------------------------------------------------------
  // Mixed text + tool calls
  // -----------------------------------------------------------------------
  test("handles text + tool calls in same response", async () => {
    fakeChunks = [
      textChunk("I will read that file."),
      ...toolCallChunks([
        { id: "call_1", name: "file_read", args: '{"path":"/a"}' },
      ]),
      usageChunk(10, 20),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Read /a" }] },
    ]);

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "I will read that file.",
    });
    expect(result.content[1]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "file_read",
      input: { path: "/a" },
    });
  });

  // -----------------------------------------------------------------------
  // Multiple tool calls
  // -----------------------------------------------------------------------
  test("handles multiple parallel tool calls", async () => {
    fakeChunks = [
      ...toolCallChunks([
        { id: "call_1", name: "file_read", args: '{"path":"/a"}' },
        { id: "call_2", name: "file_read", args: '{"path":"/b"}' },
      ]),
      usageChunk(10, 30),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Read /a and /b" }] },
    ]);

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "file_read",
      input: { path: "/a" },
    });
    expect(result.content[1]).toEqual({
      type: "tool_use",
      id: "call_2",
      name: "file_read",
      input: { path: "/b" },
    });
  });

  // -----------------------------------------------------------------------
  // Tool result messages
  // -----------------------------------------------------------------------
  test("converts tool_result blocks to tool-role messages", async () => {
    fakeChunks = [textChunk("The file contains..."), usageChunk(20, 10)];

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Read /tmp/test" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_abc",
            name: "file_read",
            input: { path: "/tmp/test" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_abc",
            content: "file content here",
            is_error: false,
          },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const sent = lastCreateParams!.messages as Array<Record<string, unknown>>;
    // user → assistant → tool → (no extra user since no text blocks)
    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual({ role: "user", content: "Read /tmp/test" });
    expect(sent[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: { name: "file_read", arguments: '{"path":"/tmp/test"}' },
        },
      ],
    });
    expect(sent[2]).toEqual({
      role: "tool",
      tool_call_id: "call_abc",
      content: "file content here",
    });
  });

  // -----------------------------------------------------------------------
  // Tool result with is_error flag
  // -----------------------------------------------------------------------
  test("prepends [ERROR] prefix when tool_result has is_error true", async () => {
    fakeChunks = [textChunk("I see the error"), usageChunk(20, 10)];

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Read /tmp/secret" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_err",
            name: "file_read",
            input: { path: "/tmp/secret" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_err",
            content: "Permission denied",
            is_error: true,
          },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const sent = lastCreateParams!.messages as Array<Record<string, unknown>>;
    expect(sent[2]).toEqual({
      role: "tool",
      tool_call_id: "call_err",
      content: "[ERROR] Permission denied",
    });
  });

  test("does not prepend [ERROR] prefix when is_error is false", async () => {
    fakeChunks = [textChunk("OK"), usageChunk(20, 10)];

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Read /tmp/test" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_ok",
            name: "file_read",
            input: { path: "/tmp/test" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_ok",
            content: "file content here",
            is_error: false,
          },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const sent = lastCreateParams!.messages as Array<Record<string, unknown>>;
    expect(sent[2]).toEqual({
      role: "tool",
      tool_call_id: "call_ok",
      content: "file content here",
    });
  });

  // -----------------------------------------------------------------------
  // Mixed tool_result + text in user message
  // -----------------------------------------------------------------------
  test("splits user message with tool_result + text into separate messages", async () => {
    fakeChunks = [textChunk("OK"), usageChunk(20, 5)];

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "test", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "result" },
          { type: "text", text: "[System: progress reminder]" },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const sent = lastCreateParams!.messages as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(4);
    // tool result first, then text as user message
    expect(sent[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "result",
    });
    expect(sent[3]).toEqual({
      role: "user",
      content: "[System: progress reminder]",
    });
  });

  // -----------------------------------------------------------------------
  // Image content
  // -----------------------------------------------------------------------
  test("converts image blocks to image_url parts", async () => {
    fakeChunks = [textChunk("A cat"), usageChunk(100, 5)];

    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const sent = lastCreateParams!.messages as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(1);
    const userMsg = sent[0] as {
      role: string;
      content: Array<Record<string, unknown>>;
    };
    expect(userMsg.content).toHaveLength(2);
    expect(userMsg.content[0]).toEqual({ type: "text", text: "What is this?" });
    expect(userMsg.content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    });
  });

  // -----------------------------------------------------------------------
  // max_tokens config
  // -----------------------------------------------------------------------
  test("passes max_tokens as max_completion_tokens", async () => {
    fakeChunks = [textChunk("OK"), usageChunk(10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      { config: { max_tokens: 64000 } },
    );

    expect(lastCreateParams!.max_completion_tokens).toBe(64000);
  });

  // -----------------------------------------------------------------------
  // Thinking blocks are skipped
  // -----------------------------------------------------------------------
  test("skips thinking blocks in user messages", async () => {
    fakeChunks = [textChunk("OK"), usageChunk(10, 2)];

    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "thinking",
            thinking: "hmm...",
            signature: "sig",
          } as ContentBlock,
          { type: "text", text: "Hello" },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const sent = lastCreateParams!.messages as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ role: "user", content: "Hello" });
  });

  // -----------------------------------------------------------------------
  // Signal passthrough
  // -----------------------------------------------------------------------
  test("passes abort signal to API call", async () => {
    fakeChunks = [textChunk("OK"), usageChunk(10, 2)];
    const controller = new AbortController();

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      { signal: controller.signal },
    );

    // The provider wraps the signal via createStreamTimeout, so the API
    // receives a different AbortSignal linked to the external one.
    const apiSignal = lastCreateOptions!.signal as AbortSignal;
    expect(apiSignal).toBeInstanceOf(AbortSignal);
    // When the caller hasn't aborted, the API signal should also be non-aborted.
    expect(apiSignal.aborted).toBe(false);
  });

  test("propagates pre-aborted signal to API call", async () => {
    fakeChunks = [textChunk("OK"), usageChunk(10, 2)];
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      { signal: controller.signal },
    );

    // When the caller's signal is already aborted, createStreamTimeout
    // immediately aborts the internal signal — proving the linkage.
    const apiSignal = lastCreateOptions!.signal as AbortSignal;
    expect(apiSignal.aborted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // API error handling
  // -----------------------------------------------------------------------
  test("wraps API errors in ProviderError", async () => {
    shouldThrow = new FakeAPIError(429, "Rate limit exceeded");

    try {
      await provider.sendMessage([
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ]);
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect((error as Error).message).toContain("OpenAI API error (429)");
      expect((error as Error).message).toContain("Rate limit exceeded");
    }
  });

  // -----------------------------------------------------------------------
  // Generic error handling
  // -----------------------------------------------------------------------
  test("wraps generic errors in ProviderError", async () => {
    shouldThrow = new Error("Network failure");

    try {
      await provider.sendMessage([
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ]);
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toContain("OpenAI request failed");
      expect((error as Error).message).toContain("Network failure");
    }
  });

  // -----------------------------------------------------------------------
  // Tagged AbortReason propagation
  // -----------------------------------------------------------------------
  test("attaches tagged abortReason to ProviderError wrapping an APIError when signal is aborted with a reason", async () => {
    shouldThrow = new FakeAPIError(0, "Request was aborted.");
    const controller = new AbortController();
    const reason = createAbortReason("user_cancel", "test:openai");
    controller.abort(reason);

    try {
      await provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        { signal: controller.signal },
      );
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).abortReason).toBe(reason);
    }
  });

  test("attaches tagged abortReason to ProviderError wrapping a generic error on abort", async () => {
    shouldThrow = new Error("socket hang up");
    const controller = new AbortController();
    const reason = createAbortReason("preempted_by_new_message", "test:openai");
    controller.abort(reason);

    try {
      await provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        { signal: controller.signal },
      );
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).abortReason).toBe(reason);
    }
  });

  test("does not attach abortReason when the signal was aborted with a non-tagged reason", async () => {
    shouldThrow = new FakeAPIError(0, "Request was aborted.");
    const controller = new AbortController();
    controller.abort(new Error("plain abort"));

    try {
      await provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        { signal: controller.signal },
      );
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).abortReason).toBeUndefined();
    }
  });

  // -----------------------------------------------------------------------
  // Malformed tool call JSON
  // -----------------------------------------------------------------------
  test("handles malformed tool call arguments gracefully", async () => {
    fakeChunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_bad",
                  type: "function" as const,
                  function: { name: "test", arguments: "not valid json{" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
        usage: null,
        model: "gpt-5.2",
      },
      usageChunk(10, 5),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "test" }] },
    ]);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "tool_use",
      id: "call_bad",
      name: "test",
      input: { _raw: "not valid json{" },
    });
  });

  // -----------------------------------------------------------------------
  // stream_options and model
  // -----------------------------------------------------------------------
  test("sends stream_options and correct model", async () => {
    fakeChunks = [textChunk("OK"), usageChunk(10, 2)];

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(lastCreateParams!.stream).toBe(true);
    expect(lastCreateParams!.stream_options).toEqual({ include_usage: true });
    expect(lastCreateParams!.model).toBe("gpt-5.2");
  });

  // -----------------------------------------------------------------------
  // Empty content response
  // -----------------------------------------------------------------------
  test("handles response with no text content", async () => {
    fakeChunks = [
      ...toolCallChunks([{ id: "call_1", name: "test", args: "{}" }]),
      usageChunk(10, 5),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "test" }] },
    ]);

    // Only tool_use, no text block
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("tool_use");
  });

  // -----------------------------------------------------------------------
  // Reasoning tokens
  // -----------------------------------------------------------------------
  test("includes reasoningTokens in usage when present in completion_tokens_details", async () => {
    fakeChunks = [
      textChunk("Reasoning result"),
      reasoningUsageChunk(50, 120, 80),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Think carefully" }] },
    ]);

    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 120,
      reasoningTokens: 80,
    });

    // Also check rawResponse diagnostics include reasoning tokens
    const rawUsage = (result.rawResponse as any).usage;
    expect(rawUsage.completion_tokens_details).toEqual({
      reasoning_tokens: 80,
    });
  });

  test("omits reasoningTokens from usage when not present", async () => {
    fakeChunks = [textChunk("Simple reply"), usageChunk(10, 5)];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.usage).not.toHaveProperty("reasoningTokens");

    // rawResponse should not include completion_tokens_details
    const rawUsage = (result.rawResponse as any).usage;
    expect(rawUsage).not.toHaveProperty("completion_tokens_details");
  });

  // -----------------------------------------------------------------------
  // Cached input tokens (prompt caching)
  // -----------------------------------------------------------------------
  test("maps cached prompt tokens to cacheReadInputTokens", async () => {
    // OpenAI's prompt_tokens already includes the cached portion, so the
    // normalized inputTokens stays at the API value and the cached subset
    // surfaces separately as cacheReadInputTokens.
    fakeChunks = [
      textChunk("Cached reply"),
      cachedUsageChunk(50_648, 114, 49_536),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(result.usage).toEqual({
      inputTokens: 50_648,
      outputTokens: 114,
      cacheReadInputTokens: 49_536,
    });

    const rawUsage = (result.rawResponse as any).usage;
    expect(rawUsage.prompt_tokens_details).toEqual({ cached_tokens: 49_536 });
  });

  test("omits cacheReadInputTokens when no cached tokens", async () => {
    fakeChunks = [textChunk("Fresh reply"), usageChunk(10, 5)];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(result.usage).not.toHaveProperty("cacheReadInputTokens");

    const rawUsage = (result.rawResponse as any).usage;
    expect(rawUsage).not.toHaveProperty("prompt_tokens_details");
  });

  // -----------------------------------------------------------------------
  // Assistant message with text preserves content
  // -----------------------------------------------------------------------
  test("preserves assistant text + tool_use in message conversion", async () => {
    fakeChunks = [textChunk("OK"), usageChunk(10, 2)];

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "call_1", name: "test", input: { x: 1 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "done" },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const sent = lastCreateParams!.messages as Array<Record<string, unknown>>;
    expect(sent[1]).toEqual({
      role: "assistant",
      content: "Let me check.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "test", arguments: '{"x":1}' },
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Custom baseURL initialization
// ---------------------------------------------------------------------------

describe("custom baseURL initialization", () => {
  beforeEach(() => {
    lastConstructorOptions = null;
  });

  test("OpenAIProvider forwards a custom baseURL", () => {
    const managed = new OpenAIProvider("ast-key-123", "gpt-4o", {
      baseURL: "https://platform.example.com/v1/runtime-proxy/openai",
    });

    expect(managed.name).toBe("openai");
    expectOpenAIConstructorOptions({
      apiKey: "ast-key-123",
      baseURL: "https://platform.example.com/v1/runtime-proxy/openai",
      timeout: DEFAULT_SDK_TIMEOUT_MS,
    });
  });

  test("OpenAIProvider without baseURL calls provider directly", () => {
    new OpenAIProvider("sk-user-key", "gpt-4o");

    expectOpenAIConstructorOptions({
      apiKey: "sk-user-key",
      baseURL: undefined,
      timeout: DEFAULT_SDK_TIMEOUT_MS,
    });
  });

  test("OpenAIProvider passes configured stream timeout plus buffer to SDK", () => {
    new OpenAIProvider("sk-user-key", "gpt-4o", {
      streamTimeoutMs: 300_000,
    });

    expectOpenAIConstructorOptions({
      apiKey: "sk-user-key",
      baseURL: undefined,
      timeout: 360_000,
    });
  });

  test("FireworksProvider forwards a custom baseURL", () => {
    const managed = new FireworksProvider(
      "ast-key-123",
      "accounts/fireworks/models/llama-v3p1-70b-instruct",
      {
        baseURL: "https://platform.example.com/v1/runtime-proxy/fireworks",
      },
    );

    expect(managed.name).toBe("fireworks");
    expectOpenAIConstructorOptions({
      apiKey: "ast-key-123",
      baseURL: "https://platform.example.com/v1/runtime-proxy/fireworks",
      timeout: DEFAULT_SDK_TIMEOUT_MS,
    });
  });

  test("FireworksProvider without custom baseURL uses default Fireworks URL", () => {
    new FireworksProvider(
      "fw-user-key",
      "accounts/fireworks/models/llama-v3p1-70b-instruct",
    );

    expectOpenAIConstructorOptions({
      apiKey: "fw-user-key",
      baseURL: "https://api.fireworks.ai/inference/v1",
      timeout: DEFAULT_SDK_TIMEOUT_MS,
    });
  });

  test("OpenRouterProvider forwards a custom baseURL", () => {
    const managed = new OpenRouterProvider("ast-key-123", "openai/gpt-4o", {
      baseURL: "https://platform.example.com/v1/runtime-proxy/openrouter",
    });

    expect(managed.name).toBe("openrouter");
    expectOpenAIConstructorOptions({
      apiKey: "ast-key-123",
      baseURL: "https://platform.example.com/v1/runtime-proxy/openrouter",
      timeout: DEFAULT_SDK_TIMEOUT_MS,
    });
  });

  test("OpenRouterProvider without custom baseURL uses default OpenRouter URL", () => {
    new OpenRouterProvider("or-user-key", "openai/gpt-4o");

    expectOpenAIConstructorOptions({
      apiKey: "or-user-key",
      baseURL: "https://openrouter.ai/api/v1",
      timeout: DEFAULT_SDK_TIMEOUT_MS,
    });
  });

  test("MinimaxProvider forwards a custom baseURL", () => {
    const managed = new MinimaxProvider("ast-key-123", "MiniMax-M2.7", {
      baseURL: "https://platform.example.com/v1/runtime-proxy/minimax",
    });

    expect(managed.name).toBe("minimax");
    expectOpenAIConstructorOptions({
      apiKey: "ast-key-123",
      baseURL: "https://platform.example.com/v1/runtime-proxy/minimax",
      timeout: DEFAULT_SDK_TIMEOUT_MS,
    });
  });

  test("MinimaxProvider without custom baseURL uses default MiniMax URL", () => {
    new MinimaxProvider("mm-user-key", "MiniMax-M2.7");

    expectOpenAIConstructorOptions({
      apiKey: "mm-user-key",
      baseURL: "https://api.minimax.io/v1",
      timeout: DEFAULT_SDK_TIMEOUT_MS,
    });
  });

  test("MinimaxProvider sends reasoning_split so reasoning never leaks into content as <think> tags", async () => {
    fakeChunks = [textChunk("hello", "stop"), usageChunk(10, 5)];
    const provider = new MinimaxProvider("mm-user-key", "MiniMax-M3");

    await provider.sendMessage([userMsg("hi")]);

    expect(lastCreateParams!.reasoning_split).toBe(true);
  });

  test("MinimaxProvider replays prior assistant thinking via reasoning_content", async () => {
    fakeChunks = [textChunk("done", "stop"), usageChunk(10, 5)];
    const provider = new MinimaxProvider("mm-user-key", "MiniMax-M3");

    await provider.sendMessage([
      userMsg("question"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "prior reasoning", signature: "" },
          { type: "text", text: "prior answer" },
        ],
      },
      userMsg("follow-up"),
    ]);

    const sent = lastCreateParams!.messages as Array<Record<string, unknown>>;
    const assistantTurn = sent.find((m) => m.role === "assistant");
    expect(assistantTurn).toEqual({
      role: "assistant",
      content: "prior answer",
      reasoning_content: "prior reasoning",
    });
  });
});

// ---------------------------------------------------------------------------
// Effort config passthrough via RetryProvider
// ---------------------------------------------------------------------------

describe("effort config passthrough", () => {
  const DUMMY_MESSAGES: Message[] = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ];

  function makeResponse(): ProviderResponse {
    return {
      content: [{ type: "text", text: "ok" }],
      model: "gpt-5.4-mini",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  }

  function makeProvider(
    name: string,
    onCall: (options: SendMessageOptions | undefined) => void,
  ): Provider {
    return {
      name,
      async sendMessage(_messages: Message[], options?: SendMessageOptions) {
        onCall(options);
        return makeResponse();
      },
    };
  }

  test("effort is preserved when passed to an OpenAI provider", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    const inner = makeProvider("openai", (opts) => {
      capturedOptions = opts;
    });
    const retry = new RetryProvider(inner);

    await retry.sendMessage(DUMMY_MESSAGES, {
      config: { effort: "high" },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.effort).toBe("high");
  });

  test("effort is stripped for unsupported providers (e.g. ollama)", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    const inner = makeProvider("ollama", (opts) => {
      capturedOptions = opts;
    });
    const retry = new RetryProvider(inner);

    await retry.sendMessage(DUMMY_MESSAGES, {
      config: { effort: "medium" },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.effort).toBeUndefined();
  });

  test("effort is preserved for fireworks provider", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    const inner = makeProvider("fireworks", (opts) => {
      capturedOptions = opts;
    });
    const retry = new RetryProvider(inner);

    await retry.sendMessage(DUMMY_MESSAGES, {
      config: { effort: "low" },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.effort).toBe("low");
  });

  test("effort is preserved for openrouter provider", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    const inner = makeProvider("openrouter", (opts) => {
      capturedOptions = opts;
    });
    const retry = new RetryProvider(inner);

    await retry.sendMessage(DUMMY_MESSAGES, {
      config: { effort: "high" },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.effort).toBe("high");
  });

  test("effort is preserved for anthropic provider", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    const inner = makeProvider("anthropic", (opts) => {
      capturedOptions = opts;
    });
    const retry = new RetryProvider(inner);

    await retry.sendMessage(DUMMY_MESSAGES, {
      config: { effort: "high" },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.effort).toBe("high");
  });

  test("thinking is still stripped for OpenAI provider", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    const inner = makeProvider("openai", (opts) => {
      capturedOptions = opts;
    });
    const retry = new RetryProvider(inner);

    await retry.sendMessage(DUMMY_MESSAGES, {
      config: {
        thinking: { enabled: true, budgetTokens: 10000 },
        effort: "high",
      },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.thinking).toBeUndefined();
    expect(config.effort).toBe("high");
  });

  test("thinking is preserved for openrouter provider", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    const inner = makeProvider("openrouter", (opts) => {
      capturedOptions = opts;
    });
    const retry = new RetryProvider(inner);

    await retry.sendMessage(DUMMY_MESSAGES, {
      config: {
        thinking: { type: "adaptive" },
      },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.thinking).toEqual({ type: "adaptive" });
  });
});

// ---------------------------------------------------------------------------
// OpenRouter reasoning ↔ thinking.enabled config
// ---------------------------------------------------------------------------

describe("OpenRouterProvider reasoning", () => {
  beforeEach(() => {
    fakeChunks = [textChunk("OK"), usageChunk(10, 2)];
    lastCreateParams = null;
    lastCreateOptions = null;
    lastConstructorOptions = null;
    shouldThrow = null;
  });

  test("sends reasoning.enabled=true with default detailed summary when thinking config is present", async () => {
    const provider = new OpenRouterProvider("or-key", "x-ai/grok-4");
    await provider.sendMessage([userMsg("hi")], {
      config: { thinking: { type: "adaptive" } },
    });

    expect(lastCreateParams).toBeTruthy();
    expect(lastCreateParams!.reasoning).toEqual({
      enabled: true,
      summary: "detailed",
    });
  });

  test("omits reasoning when thinking is explicitly disabled", async () => {
    const provider = new OpenRouterProvider("or-key", "x-ai/grok-4");
    await provider.sendMessage([userMsg("hi")], {
      config: { thinking: { type: "disabled" } },
    });

    expect(lastCreateParams).toBeTruthy();
    expect(lastCreateParams!.reasoning).toBeUndefined();
  });

  test("disabled thinking with effort none sends the flat opt-out and no nested reasoning", async () => {
    const provider = new OpenRouterProvider("or-key", "x-ai/grok-4");
    await provider.sendMessage([userMsg("hi")], {
      config: { thinking: { type: "disabled" }, effort: "none" },
    });

    expect(lastCreateParams).toBeTruthy();
    expect(lastCreateParams!.reasoning).toBeUndefined();
    expect(lastCreateParams!.reasoning_effort).toBe("none");
  });

  test("omits reasoning when thinking config is absent", async () => {
    const provider = new OpenRouterProvider("or-key", "x-ai/grok-4");
    await provider.sendMessage([userMsg("hi")], {
      config: {},
    });

    expect(lastCreateParams).toBeTruthy();
    expect(lastCreateParams!.reasoning).toBeUndefined();
  });

  test("omits reasoning when no options are provided", async () => {
    const provider = new OpenRouterProvider("or-key", "x-ai/grok-4");
    await provider.sendMessage([userMsg("hi")]);

    expect(lastCreateParams).toBeTruthy();
    expect(lastCreateParams!.reasoning).toBeUndefined();
  });

  test("sends OpenRouter app-attribution headers on OpenAI-compatible requests", async () => {
    const provider = new OpenRouterProvider("or-key", "x-ai/grok-4");
    await provider.sendMessage([userMsg("hi")], {
      config: {
        usageAttributionHeaders: {
          "Vellum-Organization-Id": "org-123",
        },
      },
    });

    expect(lastCreateOptions?.headers).toEqual(
      expect.objectContaining({
        "HTTP-Referer": "https://www.vellum.ai",
        "X-OpenRouter-Title": "Vellum Assistant",
        "X-OpenRouter-Categories": "personal-agent,cli-agent",
        "Vellum-Organization-Id": "org-123",
      }),
    );
    expect(lastCreateParams).not.toHaveProperty("HTTP-Referer");
    expect(lastCreateParams).not.toHaveProperty("X-OpenRouter-Title");
    expect(lastCreateParams).not.toHaveProperty("X-OpenRouter-Categories");
    expect(lastCreateParams).not.toHaveProperty("usageAttributionHeaders");
  });

  test("backfills placeholder content for a reasoning-only assistant turn", async () => {
    const provider = new OpenRouterProvider("or-key", "deepseek/deepseek-chat");
    await provider.sendMessage([
      userMsg("question"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "truncated reasoning", signature: "" },
        ],
      },
    ]);

    const sent = lastCreateParams!.messages as Array<{
      role: string;
      content: string | null;
      reasoning?: string;
      tool_calls?: unknown;
    }>;
    const assistantMsg = sent.find((m) => m.role === "assistant")!;
    // DeepSeek via OpenRouter rejects an assistant message with neither content
    // nor tool_calls, so the reasoning-only turn is backfilled with the sentinel
    // while the reasoning itself travels in the separate `reasoning` field.
    expect(assistantMsg.content).toBe(EMPTY_ASSISTANT_TURN_PLACEHOLDER);
    expect(assistantMsg.tool_calls).toBeUndefined();
    expect(assistantMsg.reasoning).toBe("truncated reasoning");
  });

  test("RetryProvider + OpenRouterProvider enables thinking end-to-end", async () => {
    const provider = new OpenRouterProvider("or-key", "x-ai/grok-4");
    const retry = new RetryProvider(provider);

    // thinking enabled at loop-level → config.thinking set
    await retry.sendMessage([userMsg("hi")], {
      config: { thinking: { type: "adaptive" } },
    });
    expect(lastCreateParams!.reasoning).toEqual({
      enabled: true,
      summary: "detailed",
    });
  });

  test("RetryProvider + OpenRouterProvider omits reasoning when thinking disabled", async () => {
    const provider = new OpenRouterProvider("or-key", "x-ai/grok-4");
    const retry = new RetryProvider(provider);

    await retry.sendMessage([userMsg("hi")], {
      config: { thinking: { type: "disabled" } },
    });
    expect(lastCreateParams!.reasoning).toBeUndefined();
  });

  test("nests effort under reasoning and omits top-level reasoning_effort", async () => {
    const provider = new OpenRouterProvider("or-key", "moonshotai/kimi-k2.6");
    await provider.sendMessage([userMsg("hi")], {
      config: { thinking: { enabled: true }, effort: "max" },
    });

    expect(lastCreateParams).toBeTruthy();
    expect(lastCreateParams!.reasoning).toEqual({
      enabled: true,
      effort: "xhigh",
      summary: "detailed",
    });
    // Critical: must NOT also send the OpenAI-native flat field — OpenRouter
    // rejects requests that carry both forms for reasoning models.
    expect(lastCreateParams).not.toHaveProperty("reasoning_effort");
  });
});

describe("OpenRouterProvider Anthropic-compatible errors", () => {
  test("retags Anthropic ProviderError instances as OpenRouter errors", async () => {
    const provider = new OpenRouterProvider("or-key", "anthropic/claude-4.5");
    const abortReason = createAbortReason(
      "user_cancel",
      "openrouter-provider-test",
    );
    const cause = new Error("upstream cause");
    const innerError = new ProviderError(
      "Anthropic API error (402): Payment Required",
      "anthropic",
      402,
      { cause, retryAfterMs: 1250, abortReason },
    );

    (
      provider as unknown as {
        anthropicInner: {
          sendMessage: OpenRouterProvider["sendMessage"];
        };
      }
    ).anthropicInner = {
      sendMessage: async () => {
        throw innerError;
      },
    };

    try {
      await provider.sendMessage([userMsg("hi")]);
      throw new Error("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).provider).toBe("openrouter");
      expect((error as ProviderError).statusCode).toBe(402);
      expect((error as ProviderError).retryAfterMs).toBe(1250);
      expect((error as ProviderError).abortReason).toBe(abortReason);
      expect((error as Error).cause).toBe(cause);
    }
  });
});

// ---------------------------------------------------------------------------
// Reasoning effort → OpenAI reasoning_effort mapping
// ---------------------------------------------------------------------------

describe("OpenAIProvider reasoning_effort", () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    fakeChunks = [textChunk("OK"), usageChunk(10, 2)];
    lastCreateParams = null;
    lastCreateOptions = null;
    lastConstructorOptions = null;
    shouldThrow = null;
    provider = new OpenAIProvider("test-key", "gpt-5");
  });

  test('effort: "low" maps to reasoning_effort: "low"', async () => {
    await provider.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "low" },
    });
    expect(lastCreateParams).toBeTruthy();
    expect(lastCreateParams!.reasoning_effort).toBe("low");
  });

  test('effort: "medium" maps to reasoning_effort: "medium"', async () => {
    await provider.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "medium" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("medium");
  });

  test('effort: "high" maps to reasoning_effort: "high"', async () => {
    await provider.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "high" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("high");
  });

  test('effort: "max" maps to reasoning_effort: "xhigh"', async () => {
    await provider.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "max" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("xhigh");
  });

  test('effort: "xhigh" maps to reasoning_effort: "xhigh"', async () => {
    await provider.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "xhigh" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("xhigh");
  });

  test("no effort config means no reasoning_effort in params", async () => {
    await provider.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: {},
    });
    expect(lastCreateParams).toBeTruthy();
    expect(lastCreateParams!.reasoning_effort).toBeUndefined();
  });

  test('effort: "none" is sent explicitly as reasoning_effort: "none"', async () => {
    // OpenAI defaults `reasoning_effort` to "medium" when the field is
    // omitted, so the user's opt-out is only honored when we send the
    // explicit "none" value on the wire.
    await provider.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "none" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("none");
  });

  test("extraCreateParams reasoning_effort is not clobbered when no effort is set", async () => {
    const providerWithExtra = new OpenAIProvider("test-key", "gpt-5", {
      extraCreateParams: { reasoning_effort: "medium" },
    });
    await providerWithExtra.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: {},
    });
    expect(lastCreateParams!.reasoning_effort).toBe("medium");
  });

  test('maxReasoningEffort: "high" caps "xhigh"/"max" at "high"', async () => {
    const capped = new OpenAIProvider("test-key", "gpt-5", {
      maxReasoningEffort: "high",
    });
    await capped.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "xhigh" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("high");
    await capped.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "max" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("high");
    await capped.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "medium" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("medium");
  });

  test('maxReasoningEffort: "max" passes "max" through unclamped', async () => {
    const uncapped = new OpenAIProvider("test-key", "gpt-5", {
      maxReasoningEffort: "max",
    });
    await uncapped.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "max" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("max");
    await uncapped.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "xhigh" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("xhigh");
  });
});

describe("FireworksProvider reasoning_effort ceiling", () => {
  beforeEach(() => {
    fakeChunks = [];
    lastCreateParams = null;
  });

  test('DeepSeek V4 Pro accepts "max" unclamped', async () => {
    const fw = new FireworksProvider(
      "fw-key",
      "accounts/fireworks/models/deepseek-v4-pro",
    );
    await fw.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "max" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("max");
  });

  test('DeepSeek V4 Pro accepts "xhigh" unclamped', async () => {
    const fw = new FireworksProvider(
      "fw-key",
      "accounts/fireworks/models/deepseek-v4-pro",
    );
    await fw.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "xhigh" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("xhigh");
  });

  test('Kimi K2.6 clamps "xhigh"/"max" down to "high"', async () => {
    const fw = new FireworksProvider(
      "fw-key",
      "accounts/fireworks/models/kimi-k2p6",
    );
    await fw.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "xhigh" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("high");
    await fw.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "max" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("high");
  });

  test('unknown Fireworks model falls back to "high" ceiling', async () => {
    const fw = new FireworksProvider(
      "fw-key",
      "accounts/fireworks/models/some-future-model",
    );
    await fw.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "max" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("high");
  });

  test("effort below ceiling is forwarded verbatim", async () => {
    const fw = new FireworksProvider(
      "fw-key",
      "accounts/fireworks/models/deepseek-v4-pro",
    );
    await fw.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "medium" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("medium");
  });

  test('effort: "none" passes through regardless of ceiling', async () => {
    const fw = new FireworksProvider(
      "fw-key",
      "accounts/fireworks/models/kimi-k2p6",
    );
    await fw.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: { effort: "none" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("none");
  });

  test("model override picks ceiling from runtime model, not constructor model", async () => {
    const fw = new FireworksProvider(
      "fw-key",
      "accounts/fireworks/models/kimi-k2p6",
    );
    await fw.sendMessage([userMsg("hi")], {
      systemPrompt: "system",
      config: {
        effort: "max",
        model: "accounts/fireworks/models/deepseek-v4-pro",
      },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("max");
  });
});
