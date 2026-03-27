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

// ---------------------------------------------------------------------------
// Mock openai module — must be before importing the provider
// ---------------------------------------------------------------------------

interface FakeChunk {
  choices: Array<{
    delta: {
      content?: string | null;
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
  } | null;
  model: string;
}

let fakeChunks: FakeChunk[] = [];
let lastCreateParams: Record<string, unknown> | null = null;
let lastCreateOptions: Record<string, unknown> | null = null;
let lastConstructorOptions: Record<string, unknown> | null = null;
let shouldThrow: Error | null = null;

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
import { OllamaProvider } from "../providers/ollama/client.js";
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
    expect(lastConstructorOptions).toEqual({
      apiKey: "sk-local",
      baseURL: "http://127.0.0.1:11434/v1",
    });
  });

  test("ollama wrapper uses OpenAI-compatible defaults", () => {
    const previousBaseUrl = process.env.OLLAMA_BASE_URL;
    try {
      delete process.env.OLLAMA_BASE_URL;
      const ollama = new OllamaProvider("llama3.2");
      expect(ollama.name).toBe("ollama");
      expect(lastConstructorOptions).toEqual({
        apiKey: "ollama",
        baseURL: "http://127.0.0.1:11434/v1",
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
      expect(lastConstructorOptions).toEqual({
        apiKey: "ollama",
        baseURL: "http://127.0.0.1:11434/v1",
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
      undefined,
      undefined,
      { onEvent: (e) => events.push(e) },
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text_delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "text_delta", text: ", world!" });
  });

  // -----------------------------------------------------------------------
  // System prompt
  // -----------------------------------------------------------------------
  test("places system prompt as first message", async () => {
    fakeChunks = [textChunk("OK"), usageChunk(10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      "You are a helpful assistant.",
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
      tools,
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
      undefined,
      undefined,
      { config: { max_tokens: 32000 } },
    );

    expect(lastCreateParams!.max_completion_tokens).toBe(32000);
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
      undefined,
      undefined,
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
      undefined,
      undefined,
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
    expect(lastConstructorOptions).toEqual({
      apiKey: "ast-key-123",
      baseURL: "https://platform.example.com/v1/runtime-proxy/openai",
    });
  });

  test("OpenAIProvider without baseURL calls provider directly", () => {
    new OpenAIProvider("sk-user-key", "gpt-4o");

    expect(lastConstructorOptions).toEqual({
      apiKey: "sk-user-key",
      baseURL: undefined,
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
    expect(lastConstructorOptions).toEqual({
      apiKey: "ast-key-123",
      baseURL: "https://platform.example.com/v1/runtime-proxy/fireworks",
    });
  });

  test("FireworksProvider without custom baseURL uses default Fireworks URL", () => {
    new FireworksProvider(
      "fw-user-key",
      "accounts/fireworks/models/llama-v3p1-70b-instruct",
    );

    expect(lastConstructorOptions).toEqual({
      apiKey: "fw-user-key",
      baseURL: "https://api.fireworks.ai/inference/v1",
    });
  });

  test("OpenRouterProvider forwards a custom baseURL", () => {
    const managed = new OpenRouterProvider("ast-key-123", "openai/gpt-4o", {
      baseURL: "https://platform.example.com/v1/runtime-proxy/openrouter",
    });

    expect(managed.name).toBe("openrouter");
    expect(lastConstructorOptions).toEqual({
      apiKey: "ast-key-123",
      baseURL: "https://platform.example.com/v1/runtime-proxy/openrouter",
    });
  });

  test("OpenRouterProvider without custom baseURL uses default OpenRouter URL", () => {
    new OpenRouterProvider("or-user-key", "openai/gpt-4o");

    expect(lastConstructorOptions).toEqual({
      apiKey: "or-user-key",
      baseURL: "https://openrouter.ai/api/v1",
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
      async sendMessage(_messages, _tools, _systemPrompt, options) {
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

    await retry.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
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

    await retry.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { effort: "medium" },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.effort).toBeUndefined();
  });

  test("effort is stripped for fireworks provider", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    const inner = makeProvider("fireworks", (opts) => {
      capturedOptions = opts;
    });
    const retry = new RetryProvider(inner);

    await retry.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { effort: "low" },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.effort).toBeUndefined();
  });

  test("effort is preserved for anthropic provider", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    const inner = makeProvider("anthropic", (opts) => {
      capturedOptions = opts;
    });
    const retry = new RetryProvider(inner);

    await retry.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
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

    await retry.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: {
        thinking: { enabled: true, budgetTokens: 10000 },
        effort: "high",
      },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.thinking).toBeUndefined();
    expect(config.effort).toBe("high");
  });
});
