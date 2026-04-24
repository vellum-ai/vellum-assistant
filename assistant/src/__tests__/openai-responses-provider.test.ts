import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  ProviderEvent,
  ToolDefinition,
} from "../providers/types.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { ProviderError } from "../util/errors.js";

// ---------------------------------------------------------------------------
// Mock openai module — must be before importing the provider
// ---------------------------------------------------------------------------

interface FakeStreamEvent {
  type: string;
  [key: string]: unknown;
}

let fakeStreamEvents: FakeStreamEvent[] = [];
let lastStreamParams: Record<string, unknown> | null = null;
let lastStreamOptions: Record<string, unknown> | null = null;
let lastConstructorOptions: Record<string, unknown> | null = null;
let shouldThrow: Error | null = null;

// Simulate OpenAI.APIError
class FakeAPIError extends Error {
  status: number;
  headers: Record<string, string>;
  constructor(
    status: number,
    message: string,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.status = status;
    this.headers = headers ?? {};
    this.name = "APIError";
  }
}

mock.module("openai", () => ({
  default: class MockOpenAI {
    static APIError = FakeAPIError;
    constructor(opts: Record<string, unknown>) {
      lastConstructorOptions = opts;
    }
    responses = {
      stream: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => {
        lastStreamParams = params;
        lastStreamOptions = options ?? null;
        if (shouldThrow) throw shouldThrow;

        return {
          [Symbol.asyncIterator]: async function* () {
            for (const event of fakeStreamEvents) {
              yield event;
            }
          },
        };
      },
    };
  },
}));

// Import after mocking
import { OpenAIResponsesProvider as ReExportedResponsesProvider } from "../providers/openai/client.js";
import { OpenAIResponsesProvider } from "../providers/openai/responses-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textDeltaEvent(delta: string): FakeStreamEvent {
  return { type: "response.output_text.delta", delta };
}

function functionCallAddedEvent(
  callId: string,
  name: string,
  itemId?: string,
): FakeStreamEvent {
  return {
    type: "response.output_item.added",
    item: {
      type: "function_call",
      id: itemId ?? `item_${callId}`,
      call_id: callId,
      name,
    },
  };
}

function functionCallArgsDeltaEvent(
  delta: string,
  callId?: string,
): FakeStreamEvent {
  return {
    type: "response.function_call_arguments.delta",
    delta,
    item_id: callId ? `item_${callId}` : undefined,
  };
}

function functionCallArgsDoneEvent(
  callId: string,
  name: string,
  args: string,
): FakeStreamEvent {
  return {
    type: "response.function_call_arguments.done",
    item_id: `item_${callId}`,
    name,
    arguments: args,
  };
}

function webSearchCallAddedEvent(itemId: string): FakeStreamEvent {
  return {
    type: "response.output_item.added",
    item: {
      type: "web_search_call",
      id: itemId,
    },
  };
}

function completedEvent(
  inputTokens: number,
  outputTokens: number,
  opts?: {
    reasoningTokens?: number;
    model?: string;
    status?: string;
    output?: unknown[];
  },
): FakeStreamEvent {
  // The production OpenAI SDK always includes an `output` array on the
  // response.completed event's response object. Default to an empty array so
  // the mock matches the real SDK shape (the normalizer in llm-context-
  // normalization.ts uses `output` as the signal to detect Responses API
  // payloads in stored diagnostics).
  return {
    type: "response.completed",
    response: {
      model: opts?.model ?? "gpt-5.2",
      status: opts?.status ?? "completed",
      output: opts?.output ?? [],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        output_tokens_details: {
          reasoning_tokens: opts?.reasoningTokens ?? 0,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAIResponsesProvider", () => {
  let provider: OpenAIResponsesProvider;

  beforeEach(() => {
    fakeStreamEvents = [];
    lastStreamParams = null;
    lastStreamOptions = null;
    lastConstructorOptions = null;
    shouldThrow = null;
    provider = new OpenAIResponsesProvider("sk-test-key", "gpt-5.2");
  });

  // -----------------------------------------------------------------------
  // Re-export check
  // -----------------------------------------------------------------------
  test("is re-exported from client.ts", () => {
    expect(ReExportedResponsesProvider).toBe(OpenAIResponsesProvider);
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------
  test("passes apiKey and baseURL to OpenAI client", () => {
    new OpenAIResponsesProvider("sk-custom", "gpt-5.4", {
      baseURL: "https://proxy.example.com/v1",
      providerName: "openai-managed",
      providerLabel: "Managed OpenAI",
    });

    expect(lastConstructorOptions).toEqual({
      apiKey: "sk-custom",
      baseURL: "https://proxy.example.com/v1",
    });
  });

  test("defaults providerName to openai", () => {
    const p = new OpenAIResponsesProvider("sk-key", "gpt-5.2");
    expect(p.name).toBe("openai");
  });

  // -----------------------------------------------------------------------
  // Basic text response
  // -----------------------------------------------------------------------
  test("returns text response from streaming events", async () => {
    fakeStreamEvents = [
      textDeltaEvent("Hello"),
      textDeltaEvent(", world!"),
      completedEvent(10, 5),
    ];

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
    fakeStreamEvents = [
      textDeltaEvent("Hello"),
      textDeltaEvent(", world!"),
      completedEvent(10, 5),
    ];

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
  test("places system prompt in instructions param", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      "You are a helpful assistant.",
    );

    expect(lastStreamParams!.instructions).toBe("You are a helpful assistant.");
    // System prompt should NOT appear in the input array
    const input = lastStreamParams!.input as unknown[];
    for (const item of input) {
      const role = (item as Record<string, unknown>).role;
      expect(role).not.toBe("system");
    }
  });

  test("strips SYSTEM_PROMPT_CACHE_BOUNDARY from system prompt", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      "Before\n<!-- SYSTEM_PROMPT_CACHE_BOUNDARY -->\nAfter",
    );

    expect(lastStreamParams!.instructions).toBe("Before\nAfter");
  });

  // -----------------------------------------------------------------------
  // Tool definitions
  // -----------------------------------------------------------------------
  test("converts tool definitions to Responses function tool format", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

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

    const sentTools = lastStreamParams!.tools as Array<Record<string, unknown>>;
    expect(sentTools).toHaveLength(1);
    expect(sentTools[0]).toEqual({
      type: "function",
      name: "file_read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      strict: null,
    });
  });

  // -----------------------------------------------------------------------
  // Tool call response
  // -----------------------------------------------------------------------
  test("parses tool calls from streaming events", async () => {
    fakeStreamEvents = [
      functionCallAddedEvent("call_abc", "file_read"),
      functionCallArgsDeltaEvent('{"path":"/tmp/test"}', "call_abc"),
      functionCallArgsDoneEvent(
        "call_abc",
        "file_read",
        '{"path":"/tmp/test"}',
      ),
      completedEvent(10, 15),
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
  });

  // -----------------------------------------------------------------------
  // Mixed text + tool calls
  // -----------------------------------------------------------------------
  test("handles text + tool calls in same response", async () => {
    fakeStreamEvents = [
      textDeltaEvent("I will read that file."),
      functionCallAddedEvent("call_1", "file_read"),
      functionCallArgsDeltaEvent('{"path":"/a"}', "call_1"),
      functionCallArgsDoneEvent("call_1", "file_read", '{"path":"/a"}'),
      completedEvent(10, 20),
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
    fakeStreamEvents = [
      functionCallAddedEvent("call_1", "file_read"),
      functionCallArgsDeltaEvent('{"path":"/a"}', "call_1"),
      functionCallArgsDoneEvent("call_1", "file_read", '{"path":"/a"}'),
      functionCallAddedEvent("call_2", "file_read"),
      functionCallArgsDeltaEvent('{"path":"/b"}', "call_2"),
      functionCallArgsDoneEvent("call_2", "file_read", '{"path":"/b"}'),
      completedEvent(10, 30),
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
  // Malformed tool call JSON
  // -----------------------------------------------------------------------
  test("handles malformed tool call arguments gracefully", async () => {
    fakeStreamEvents = [
      functionCallAddedEvent("call_bad", "test"),
      functionCallArgsDeltaEvent("not valid json{", "call_bad"),
      functionCallArgsDoneEvent("call_bad", "test", "not valid json{"),
      completedEvent(10, 5),
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
  // Reasoning tokens
  // -----------------------------------------------------------------------
  test("includes reasoningTokens in usage when present", async () => {
    fakeStreamEvents = [
      textDeltaEvent("Reasoning result"),
      completedEvent(50, 120, { reasoningTokens: 80 }),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Think carefully" }] },
    ]);

    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 120,
      reasoningTokens: 80,
    });
  });

  test("omits reasoningTokens from usage when zero", async () => {
    fakeStreamEvents = [textDeltaEvent("Simple reply"), completedEvent(10, 5)];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.usage).not.toHaveProperty("reasoningTokens");
  });

  // -----------------------------------------------------------------------
  // max_tokens → max_output_tokens
  // -----------------------------------------------------------------------
  test("passes max_tokens as max_output_tokens", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      undefined,
      { config: { max_tokens: 64000 } },
    );

    expect(lastStreamParams!.max_output_tokens).toBe(64000);
  });

  // -----------------------------------------------------------------------
  // Effort → reasoning param
  // -----------------------------------------------------------------------
  test('effort: "high" maps to reasoning: { effort: "high" }', async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      undefined,
      { config: { effort: "high" } },
    );

    expect(lastStreamParams!.reasoning).toEqual({ effort: "high" });
  });

  test('effort: "max" maps to reasoning: { effort: "high" }', async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      undefined,
      { config: { effort: "max" } },
    );

    expect(lastStreamParams!.reasoning).toEqual({ effort: "high" });
  });

  test('effort: "xhigh" maps to reasoning: { effort: "high" }', async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      undefined,
      { config: { effort: "xhigh" } },
    );

    expect(lastStreamParams!.reasoning).toEqual({ effort: "high" });
  });

  test("no effort config means no reasoning in params", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      undefined,
      { config: {} },
    );

    expect(lastStreamParams!.reasoning).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Verbosity → text param
  // -----------------------------------------------------------------------
  test('verbosity: "low" maps to text: { verbosity: "low" }', async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      undefined,
      { config: { verbosity: "low" } },
    );

    expect(lastStreamParams!.text).toEqual({ verbosity: "low" });
  });

  test('verbosity: "high" maps to text: { verbosity: "high" }', async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      undefined,
      { config: { verbosity: "high" } },
    );

    expect(lastStreamParams!.text).toEqual({ verbosity: "high" });
  });

  test("no verbosity config means no text param", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      undefined,
      { config: {} },
    );

    expect(lastStreamParams!.text).toBeUndefined();
  });

  test("unrecognized verbosity value is ignored", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      undefined,
      { config: { verbosity: "bogus" } },
    );

    expect(lastStreamParams!.text).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Model override
  // -----------------------------------------------------------------------
  test("uses model from config when provided", async () => {
    fakeStreamEvents = [
      textDeltaEvent("OK"),
      completedEvent(10, 2, { model: "gpt-5.4" }),
    ];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      undefined,
      { config: { model: "gpt-5.4" } },
    );

    expect(lastStreamParams!.model).toBe("gpt-5.4");
  });

  // -----------------------------------------------------------------------
  // store: false
  // -----------------------------------------------------------------------
  test("sends store: false in params", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(lastStreamParams!.store).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Message conversion — user text
  // -----------------------------------------------------------------------
  test("converts user text to input_text format", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    const input = lastStreamParams!.input as unknown[];
    expect(input).toHaveLength(1);
    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Hello" }],
    });
  });

  // -----------------------------------------------------------------------
  // Message conversion — user image
  // -----------------------------------------------------------------------
  test("converts user image to input_image format", async () => {
    fakeStreamEvents = [textDeltaEvent("A cat"), completedEvent(100, 5)];

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

    const input = lastStreamParams!.input as unknown[];
    expect(input).toHaveLength(1);
    const userMsg = input[0] as { content: unknown[] };
    expect(userMsg.content).toHaveLength(2);
    expect(userMsg.content[0]).toEqual({
      type: "input_text",
      text: "What is this?",
    });
    expect(userMsg.content[1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,iVBORw0KGgo=",
    });
  });

  // -----------------------------------------------------------------------
  // Message conversion — assistant text
  // -----------------------------------------------------------------------
  test("converts assistant text to output_text format", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
      { role: "user", content: [{ type: "text", text: "How are you?" }] },
    ];

    await provider.sendMessage(messages);

    const input = lastStreamParams!.input as unknown[];
    expect(input).toHaveLength(3);
    expect(input[1]).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Hi there" }],
    });
  });

  // -----------------------------------------------------------------------
  // Message conversion — assistant tool_use → function_call
  // -----------------------------------------------------------------------
  test("converts assistant tool_use to function_call input item", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Read file" }] },
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
            content: "file content",
          },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const input = lastStreamParams!.input as unknown[];
    // user → function_call → function_call_output
    expect(input).toHaveLength(3);
    expect(input[1]).toEqual({
      type: "function_call",
      call_id: "call_abc",
      name: "file_read",
      arguments: '{"path":"/tmp/test"}',
    });
    expect(input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_abc",
      output: "file content",
    });
  });

  // -----------------------------------------------------------------------
  // Message conversion — tool_result with is_error
  // -----------------------------------------------------------------------
  test("prepends [ERROR] prefix for tool_result with is_error", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Read secret" }] },
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

    const input = lastStreamParams!.input as unknown[];
    const callOutput = input[2] as Record<string, unknown>;
    expect(callOutput).toEqual({
      type: "function_call_output",
      call_id: "call_err",
      output: "[ERROR] Permission denied",
    });
  });

  // -----------------------------------------------------------------------
  // Message conversion — assistant text + tool_use
  // -----------------------------------------------------------------------
  test("converts assistant text + tool_use to message + function_call", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

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

    const input = lastStreamParams!.input as unknown[];
    // user → assistant message → function_call → function_call_output
    expect(input).toHaveLength(4);
    expect(input[1]).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Let me check." }],
    });
    expect(input[2]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "test",
      arguments: '{"x":1}',
    });
  });

  // -----------------------------------------------------------------------
  // Signal passthrough
  // -----------------------------------------------------------------------
  test("passes abort signal to API call via createStreamTimeout", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];
    const controller = new AbortController();

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      undefined,
      { signal: controller.signal },
    );

    const apiSignal = lastStreamOptions!.signal as AbortSignal;
    expect(apiSignal).toBeInstanceOf(AbortSignal);
    expect(apiSignal.aborted).toBe(false);
  });

  test("propagates pre-aborted signal", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      undefined,
      { signal: controller.signal },
    );

    const apiSignal = lastStreamOptions!.signal as AbortSignal;
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
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).toContain("OpenAI API error (429)");
      expect((error as Error).message).toContain("Rate limit exceeded");
    }
  });

  test("extracts retry-after from API error headers", async () => {
    shouldThrow = new FakeAPIError(429, "Rate limit exceeded", {
      "retry-after": "30",
    });

    try {
      await provider.sendMessage([
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ]);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retryAfterMs).toBe(30000);
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
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).toContain("OpenAI request failed");
      expect((error as Error).message).toContain("Network failure");
    }
  });

  // -----------------------------------------------------------------------
  // Tagged AbortReason propagation
  // -----------------------------------------------------------------------
  test("attaches tagged abortReason to ProviderError wrapping an APIError", async () => {
    shouldThrow = new FakeAPIError(0, "Request was aborted.");
    const controller = new AbortController();
    const reason = createAbortReason("user_cancel", "test:responses");
    controller.abort(reason);

    try {
      await provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        undefined,
        undefined,
        { signal: controller.signal },
      );
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).abortReason).toBe(reason);
    }
  });

  test("attaches tagged abortReason to ProviderError wrapping a generic error", async () => {
    shouldThrow = new Error("socket hang up");
    const controller = new AbortController();
    const reason = createAbortReason(
      "preempted_by_new_message",
      "test:responses",
    );
    controller.abort(reason);

    try {
      await provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        undefined,
        undefined,
        { signal: controller.signal },
      );
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).abortReason).toBe(reason);
    }
  });

  test("does not attach abortReason when signal has non-tagged reason", async () => {
    shouldThrow = new FakeAPIError(0, "Request was aborted.");
    const controller = new AbortController();
    controller.abort(new Error("plain abort"));

    try {
      await provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        undefined,
        undefined,
        { signal: controller.signal },
      );
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).abortReason).toBeUndefined();
    }
  });

  // -----------------------------------------------------------------------
  // rawRequest / rawResponse diagnostics
  // -----------------------------------------------------------------------
  test("captures rawRequest and rawResponse for diagnostics", async () => {
    // The OpenAI SDK's response.completed event includes an `output` array
    // on the response. The normalizer in llm-context-normalization.ts uses
    // the presence of `output` as the signal to detect Responses API
    // payloads in stored diagnostics, so the provider must preserve it.
    const sdkOutput = [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello" }],
      },
    ];
    fakeStreamEvents = [
      textDeltaEvent("Hello"),
      completedEvent(10, 5, { model: "gpt-5.2", output: sdkOutput }),
    ];

    const result = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      "System prompt",
    );

    // rawRequest should contain the params sent to responses.stream()
    const rawReq = result.rawRequest as Record<string, unknown>;
    expect(rawReq.model).toBe("gpt-5.2");
    expect(rawReq.instructions).toBe("System prompt");
    expect(rawReq.store).toBe(false);

    // rawResponse should contain the final response object, including `output`
    // which downstream normalization relies on for Responses API detection.
    const rawResp = result.rawResponse as Record<string, unknown>;
    expect(rawResp).toBeDefined();
    expect((rawResp as any).model).toBe("gpt-5.2");
    expect((rawResp as any).usage.input_tokens).toBe(10);
    expect((rawResp as any).usage.output_tokens).toBe(5);
    expect((rawResp as any).output).toEqual(sdkOutput);
  });

  // -----------------------------------------------------------------------
  // Thinking blocks are skipped in user messages
  // -----------------------------------------------------------------------
  test("skips thinking blocks in user messages", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "thinking",
            thinking: "hmm...",
            signature: "sig",
          },
          { type: "text", text: "Hello" },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const input = lastStreamParams!.input as unknown[];
    expect(input).toHaveLength(1);
    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Hello" }],
    });
  });

  // -----------------------------------------------------------------------
  // File content blocks
  // -----------------------------------------------------------------------
  test("converts file blocks to text with XML header", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "base64data",
              filename: "doc.pdf",
            },
            extracted_text: "Hello world PDF content",
          },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const input = lastStreamParams!.input as unknown[];
    const userMsg = input[0] as { content: Array<Record<string, unknown>> };
    expect(userMsg.content[0]).toEqual({
      type: "input_text",
      text: '<attached_file name="doc.pdf" type="application/pdf" />\nHello world PDF content',
    });
  });

  // -----------------------------------------------------------------------
  // Mixed tool_result + text in user message
  // -----------------------------------------------------------------------
  test("splits user message with tool_result + text correctly", async () => {
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(20, 5)];

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

    const input = lastStreamParams!.input as unknown[];
    // user → function_call → function_call_output → user (text)
    expect(input).toHaveLength(4);
    expect(input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "result",
    });
    expect(input[3]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "[System: progress reminder]" }],
    });
  });

  // -----------------------------------------------------------------------
  // Empty content response (tool calls only)
  // -----------------------------------------------------------------------
  test("handles response with no text content", async () => {
    fakeStreamEvents = [
      functionCallAddedEvent("call_1", "test"),
      functionCallArgsDeltaEvent("{}", "call_1"),
      functionCallArgsDoneEvent("call_1", "test", "{}"),
      completedEvent(10, 5),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "test" }] },
    ]);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("tool_use");
  });

  // -----------------------------------------------------------------------
  // Status mapping
  // -----------------------------------------------------------------------
  test('maps "completed" status to "stop" stopReason', async () => {
    fakeStreamEvents = [
      textDeltaEvent("OK"),
      completedEvent(10, 2, { status: "completed" }),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(result.stopReason).toBe("stop");
  });

  test("passes through non-completed status as stopReason", async () => {
    fakeStreamEvents = [
      textDeltaEvent("OK"),
      completedEvent(10, 2, { status: "incomplete" }),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(result.stopReason).toBe("incomplete");
  });
});

// ---------------------------------------------------------------------------
// Native web search tool mapping
// ---------------------------------------------------------------------------

describe("OpenAIResponsesProvider — Native Web Search", () => {
  const webSearchTool: ToolDefinition = {
    name: "web_search",
    description: "Search the web",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  };

  const fileReadTool: ToolDefinition = {
    name: "file_read",
    description: "Read a file",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  };

  beforeEach(() => {
    fakeStreamEvents = [];
    lastStreamParams = null;
    lastStreamOptions = null;
    lastConstructorOptions = null;
    shouldThrow = null;
  });

  test("maps web_search to native web_search_preview tool when useNativeWebSearch is enabled", async () => {
    const nativeProvider = new OpenAIResponsesProvider("sk-test", "gpt-5.2", {
      useNativeWebSearch: true,
    });
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await nativeProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Search for cats" }] }],
      [webSearchTool],
    );

    const sentTools = lastStreamParams!.tools as Array<Record<string, unknown>>;
    expect(sentTools).toHaveLength(1);
    expect(sentTools[0]).toEqual({ type: "web_search_preview" });
  });

  test("keeps web_search as function tool when useNativeWebSearch is disabled", async () => {
    const nonNativeProvider = new OpenAIResponsesProvider("sk-test", "gpt-5.2");
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await nonNativeProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Search for cats" }] }],
      [webSearchTool],
    );

    const sentTools = lastStreamParams!.tools as Array<Record<string, unknown>>;
    expect(sentTools).toHaveLength(1);
    expect(sentTools[0]).toEqual({
      type: "function",
      name: "web_search",
      description: "Search the web",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      strict: null,
    });
  });

  test("mixes native web_search_preview with regular function tools", async () => {
    const nativeProvider = new OpenAIResponsesProvider("sk-test", "gpt-5.2", {
      useNativeWebSearch: true,
    });
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await nativeProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Search and read" }] }],
      [fileReadTool, webSearchTool],
    );

    const sentTools = lastStreamParams!.tools as Array<Record<string, unknown>>;
    expect(sentTools).toHaveLength(2);
    // Non-web-search tools remain as function tools
    expect(sentTools[0]).toEqual({
      type: "function",
      name: "file_read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      strict: null,
    });
    // web_search is mapped to native tool
    expect(sentTools[1]).toEqual({ type: "web_search_preview" });
  });

  test("sends all tools as function tools when no web_search is present and native mode is on", async () => {
    const nativeProvider = new OpenAIResponsesProvider("sk-test", "gpt-5.2", {
      useNativeWebSearch: true,
    });
    fakeStreamEvents = [textDeltaEvent("OK"), completedEvent(10, 2)];

    await nativeProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Read file" }] }],
      [fileReadTool],
    );

    const sentTools = lastStreamParams!.tools as Array<Record<string, unknown>>;
    expect(sentTools).toHaveLength(1);
    expect(sentTools[0]).toEqual({
      type: "function",
      name: "file_read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      strict: null,
    });
  });

  // -----------------------------------------------------------------------
  // web_search_call stream event handling
  // -----------------------------------------------------------------------

  test("emits server_tool_start when web_search_call output item is added", async () => {
    const nativeProvider = new OpenAIResponsesProvider("sk-test", "gpt-5.2", {
      useNativeWebSearch: true,
    });
    fakeStreamEvents = [
      webSearchCallAddedEvent("ws_call_1"),
      textDeltaEvent("Search results here."),
      completedEvent(50, 30),
    ];

    const events: ProviderEvent[] = [];
    await nativeProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Search for cats" }] }],
      [webSearchTool],
      undefined,
      { onEvent: (e) => events.push(e) },
    );

    const startEvents = events.filter((e) => e.type === "server_tool_start");
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]).toEqual({
      type: "server_tool_start",
      name: "web_search",
      toolUseId: "ws_call_1",
      input: {},
    });
  });

  test("emits server_tool_complete on response.completed for tracked web search calls", async () => {
    const nativeProvider = new OpenAIResponsesProvider("sk-test", "gpt-5.2", {
      useNativeWebSearch: true,
    });
    fakeStreamEvents = [
      webSearchCallAddedEvent("ws_call_1"),
      textDeltaEvent("Answer with citations."),
      completedEvent(50, 30),
    ];

    const events: ProviderEvent[] = [];
    await nativeProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Search for dogs" }] }],
      [webSearchTool],
      undefined,
      { onEvent: (e) => events.push(e) },
    );

    const completeEvents = events.filter(
      (e) => e.type === "server_tool_complete",
    );
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0]).toEqual({
      type: "server_tool_complete",
      toolUseId: "ws_call_1",
      isError: false,
    });
  });

  test("emits server_tool_complete for multiple web search calls", async () => {
    const nativeProvider = new OpenAIResponsesProvider("sk-test", "gpt-5.2", {
      useNativeWebSearch: true,
    });
    fakeStreamEvents = [
      webSearchCallAddedEvent("ws_call_1"),
      webSearchCallAddedEvent("ws_call_2"),
      textDeltaEvent("Combined results."),
      completedEvent(80, 50),
    ];

    const events: ProviderEvent[] = [];
    await nativeProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Search multiple" }] }],
      [webSearchTool],
      undefined,
      { onEvent: (e) => events.push(e) },
    );

    const startEvents = events.filter((e) => e.type === "server_tool_start");
    expect(startEvents).toHaveLength(2);
    expect(startEvents[0]).toEqual({
      type: "server_tool_start",
      name: "web_search",
      toolUseId: "ws_call_1",
      input: {},
    });
    expect(startEvents[1]).toEqual({
      type: "server_tool_start",
      name: "web_search",
      toolUseId: "ws_call_2",
      input: {},
    });

    const completeEvents = events.filter(
      (e) => e.type === "server_tool_complete",
    );
    expect(completeEvents).toHaveLength(2);
    expect(completeEvents[0]).toEqual({
      type: "server_tool_complete",
      toolUseId: "ws_call_1",
      isError: false,
    });
    expect(completeEvents[1]).toEqual({
      type: "server_tool_complete",
      toolUseId: "ws_call_2",
      isError: false,
    });
  });

  test("does not emit server_tool events for non-web-search output items", async () => {
    const nativeProvider = new OpenAIResponsesProvider("sk-test", "gpt-5.2", {
      useNativeWebSearch: true,
    });
    fakeStreamEvents = [
      functionCallAddedEvent("call_1", "file_read"),
      functionCallArgsDeltaEvent('{"path":"/tmp/a"}', "call_1"),
      functionCallArgsDoneEvent("call_1", "file_read", '{"path":"/tmp/a"}'),
      completedEvent(20, 10),
    ];

    const events: ProviderEvent[] = [];
    await nativeProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Read file" }] }],
      [fileReadTool],
      undefined,
      { onEvent: (e) => events.push(e) },
    );

    const serverToolEvents = events.filter(
      (e) =>
        e.type === "server_tool_start" || e.type === "server_tool_complete",
    );
    expect(serverToolEvents).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // server_tool_use content blocks in ProviderResponse
  // -----------------------------------------------------------------------

  test("includes paired server_tool_use + web_search_tool_result content blocks for web search calls", async () => {
    const nativeProvider = new OpenAIResponsesProvider("sk-test", "gpt-5.2", {
      useNativeWebSearch: true,
    });
    fakeStreamEvents = [
      webSearchCallAddedEvent("ws_call_1"),
      textDeltaEvent("Here are the results."),
      completedEvent(50, 30),
    ];

    const result = await nativeProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Search for cats" }] }],
      [webSearchTool],
    );

    // server_tool_use + web_search_tool_result pair should appear before text
    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toEqual({
      type: "server_tool_use",
      id: "ws_call_1",
      name: "web_search",
      input: {},
    });
    expect(result.content[1]).toEqual({
      type: "web_search_tool_result",
      tool_use_id: "ws_call_1",
      content: [],
    });
    expect(result.content[2]).toEqual({
      type: "text",
      text: "Here are the results.",
    });
  });

  test("includes paired server_tool_use + web_search_tool_result for multiple web search calls", async () => {
    const nativeProvider = new OpenAIResponsesProvider("sk-test", "gpt-5.2", {
      useNativeWebSearch: true,
    });
    fakeStreamEvents = [
      webSearchCallAddedEvent("ws_call_1"),
      webSearchCallAddedEvent("ws_call_2"),
      textDeltaEvent("Combined search results."),
      completedEvent(80, 50),
    ];

    const result = await nativeProvider.sendMessage(
      [
        {
          role: "user",
          content: [{ type: "text", text: "Search two things" }],
        },
      ],
      [webSearchTool],
    );

    expect(result.content).toHaveLength(5);
    expect(result.content[0]).toEqual({
      type: "server_tool_use",
      id: "ws_call_1",
      name: "web_search",
      input: {},
    });
    expect(result.content[1]).toEqual({
      type: "web_search_tool_result",
      tool_use_id: "ws_call_1",
      content: [],
    });
    expect(result.content[2]).toEqual({
      type: "server_tool_use",
      id: "ws_call_2",
      name: "web_search",
      input: {},
    });
    expect(result.content[3]).toEqual({
      type: "web_search_tool_result",
      tool_use_id: "ws_call_2",
      content: [],
    });
    expect(result.content[4]).toEqual({
      type: "text",
      text: "Combined search results.",
    });
  });

  test("does not include server_tool_use blocks when no web search calls occur", async () => {
    const nativeProvider = new OpenAIResponsesProvider("sk-test", "gpt-5.2", {
      useNativeWebSearch: true,
    });
    fakeStreamEvents = [
      textDeltaEvent("No search needed."),
      completedEvent(10, 5),
    ];

    const result = await nativeProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      [webSearchTool],
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "No search needed.",
    });
  });
});
