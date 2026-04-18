import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ContentBlock,
  Message,
  ProviderEvent,
  ToolDefinition,
} from "../providers/types.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { ProviderError } from "../util/errors.js";

// ---------------------------------------------------------------------------
// Mock @google/genai module — must be before importing the provider
// ---------------------------------------------------------------------------

interface FakeChunk {
  text?: string;
  functionCalls?: Array<{
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  }>;
  candidates?: Array<{
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  modelVersion?: string;
}

let fakeChunks: FakeChunk[] = [];
let lastStreamParams: Record<string, unknown> | null = null;
let lastConstructorOpts: Record<string, unknown> | null = null;
let shouldThrow: Error | null = null;

class FakeApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

mock.module("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    constructor(opts: Record<string, unknown>) {
      lastConstructorOpts = opts;
    }
    models = {
      generateContentStream: async (params: Record<string, unknown>) => {
        lastStreamParams = params;
        if (shouldThrow) throw shouldThrow;

        return {
          [Symbol.asyncIterator]: async function* () {
            for (const chunk of fakeChunks) {
              yield chunk;
            }
          },
        };
      },
    };
  },
  ApiError: FakeApiError,
}));

// Import after mocking
import { GeminiProvider } from "../providers/gemini/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textChunk(text: string): FakeChunk {
  return { text };
}

function finishChunk(
  reason: string,
  prompt: number,
  output: number,
): FakeChunk {
  return {
    candidates: [{ finishReason: reason }],
    usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: output },
    modelVersion: "gemini-3-flash-001",
  };
}

function functionCallChunk(
  calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>,
): FakeChunk {
  return {
    functionCalls: calls.map((c) => ({
      id: c.id,
      name: c.name,
      args: c.args,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GeminiProvider", () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    provider = new GeminiProvider("test-api-key", "gemini-3-flash");
    fakeChunks = [];
    lastStreamParams = null;
    lastConstructorOpts = null;
    shouldThrow = null;
  });

  // -----------------------------------------------------------------------
  // Basic text response
  // -----------------------------------------------------------------------
  test("returns text response from streaming chunks", async () => {
    fakeChunks = [
      textChunk("Hello"),
      textChunk(", world!"),
      finishChunk("STOP", 10, 5),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "Hello, world!" });
    expect(result.model).toBe("gemini-3-flash-001");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.stopReason).toBe("STOP");
  });

  // -----------------------------------------------------------------------
  // Streaming events
  // -----------------------------------------------------------------------
  test("fires text_delta events during streaming", async () => {
    fakeChunks = [
      textChunk("Hello"),
      textChunk(", world!"),
      finishChunk("STOP", 10, 5),
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
  test("passes system prompt in config.systemInstruction", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      "You are a helpful assistant.",
    );

    const config = lastStreamParams!.config as Record<string, unknown>;
    expect(config.systemInstruction).toBe("You are a helpful assistant.");
  });

  // -----------------------------------------------------------------------
  // Tool definitions
  // -----------------------------------------------------------------------
  test("converts tool definitions to Gemini functionDeclarations", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

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

    const config = lastStreamParams!.config as Record<string, unknown>;
    const sentTools = config.tools as Array<Record<string, unknown>>;
    expect(sentTools).toHaveLength(1);
    const decls = (sentTools[0] as { functionDeclarations: unknown[] })
      .functionDeclarations;
    expect(decls).toHaveLength(1);
    expect(decls[0]).toEqual({
      name: "file_read",
      description: "Read a file",
      parametersJsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    });
  });

  // -----------------------------------------------------------------------
  // Function call response
  // -----------------------------------------------------------------------
  test("parses function calls from streaming chunks", async () => {
    fakeChunks = [
      functionCallChunk([
        { id: "call_abc", name: "file_read", args: { path: "/tmp/test" } },
      ]),
      finishChunk("STOP", 10, 15),
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
  // Function call without id — fallback to call_N
  // -----------------------------------------------------------------------
  test("generates fallback id when function call has no id", async () => {
    fakeChunks = [
      functionCallChunk([{ name: "test", args: { x: 1 } }]),
      finishChunk("STOP", 10, 5),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "test" }] },
    ]);

    expect(result.content).toHaveLength(1);
    const block = result.content[0] as {
      type: string;
      id: string;
      name: string;
      input: unknown;
    };
    expect(block.type).toBe("tool_use");
    expect(block.id).toStartWith("call_");
    expect(block.id.length).toBeGreaterThan(5); // call_ + UUID
    expect(block.name).toBe("test");
    expect(block.input).toEqual({ x: 1 });
  });

  test("generates unique fallback ids across multiple calls", async () => {
    fakeChunks = [
      functionCallChunk([{ name: "tool_a", args: {} }]),
      finishChunk("STOP", 10, 5),
    ];

    const result1 = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "call 1" }] },
    ]);

    fakeChunks = [
      functionCallChunk([{ name: "tool_b", args: {} }]),
      finishChunk("STOP", 10, 5),
    ];

    const result2 = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "call 2" }] },
    ]);

    const id1 = (result1.content[0] as { id: string }).id;
    const id2 = (result2.content[0] as { id: string }).id;
    expect(id1).not.toBe(id2);
  });

  // -----------------------------------------------------------------------
  // Multiple function calls
  // -----------------------------------------------------------------------
  test("handles multiple function calls", async () => {
    fakeChunks = [
      functionCallChunk([
        { id: "call_1", name: "file_read", args: { path: "/a" } },
        { id: "call_2", name: "file_read", args: { path: "/b" } },
      ]),
      finishChunk("STOP", 10, 30),
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
  // Mixed text + function calls
  // -----------------------------------------------------------------------
  test("handles text + function calls in same response", async () => {
    fakeChunks = [
      textChunk("I will read that file."),
      functionCallChunk([
        { id: "call_1", name: "file_read", args: { path: "/a" } },
      ]),
      finishChunk("STOP", 10, 20),
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
  // Message conversion — role mapping
  // -----------------------------------------------------------------------
  test("maps assistant role to model and user role to user", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 20, 5)];

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
      { role: "user", content: [{ type: "text", text: "How are you?" }] },
    ];

    await provider.sendMessage(messages);

    const contents = lastStreamParams!.contents as Array<{
      role: string;
      parts: unknown[];
    }>;
    expect(contents).toHaveLength(3);
    expect(contents[0].role).toBe("user");
    expect(contents[1].role).toBe("model");
    expect(contents[2].role).toBe("user");
  });

  // -----------------------------------------------------------------------
  // Tool result conversion — functionResponse with name lookup
  // -----------------------------------------------------------------------
  test("converts tool_result blocks to functionResponse with name lookup", async () => {
    fakeChunks = [
      textChunk("The file contains..."),
      finishChunk("STOP", 20, 10),
    ];

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

    const contents = lastStreamParams!.contents as Array<{
      role: string;
      parts: unknown[];
    }>;
    // assistant → model with functionCall, user → user with functionResponse
    expect(contents).toHaveLength(3);
    expect(contents[1].role).toBe("model");
    expect(contents[1].parts[0]).toEqual({
      functionCall: {
        name: "file_read",
        args: { path: "/tmp/test" },
      },
    });
    expect(contents[2].role).toBe("user");
    expect(contents[2].parts[0]).toEqual({
      functionResponse: {
        name: "file_read",
        response: { output: "file content here" },
      },
    });
  });

  // -----------------------------------------------------------------------
  // Tool result with unknown tool_use_id — falls back to id as name
  // -----------------------------------------------------------------------
  test("falls back to tool_use_id as name when tool_use not found", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "unknown_id",
            content: "some result",
          },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const contents = lastStreamParams!.contents as Array<{
      role: string;
      parts: unknown[];
    }>;
    expect(contents[0].parts[0]).toEqual({
      functionResponse: {
        name: "unknown_id",
        response: { output: "some result" },
      },
    });
  });

  // -----------------------------------------------------------------------
  // Image content
  // -----------------------------------------------------------------------
  test("converts image blocks to inlineData parts", async () => {
    fakeChunks = [textChunk("A cat"), finishChunk("STOP", 100, 5)];

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

    const contents = lastStreamParams!.contents as Array<{
      role: string;
      parts: unknown[];
    }>;
    expect(contents).toHaveLength(1);
    expect(contents[0].parts).toHaveLength(2);
    expect(contents[0].parts[0]).toEqual({ text: "What is this?" });
    expect(contents[0].parts[1]).toEqual({
      inlineData: {
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
      },
    });
  });

  // -----------------------------------------------------------------------
  // max_tokens config
  // -----------------------------------------------------------------------
  test("passes max_tokens as maxOutputTokens", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      undefined,
      { config: { max_tokens: 64000 } },
    );

    const config = lastStreamParams!.config as Record<string, unknown>;
    expect(config.maxOutputTokens).toBe(64000);
  });

  // -----------------------------------------------------------------------
  // Abort signal
  // -----------------------------------------------------------------------
  test("passes abort signal in config", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];
    const controller = new AbortController();

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      undefined,
      undefined,
      { signal: controller.signal },
    );

    // The provider wraps the signal via createStreamTimeout, so the API
    // receives a different AbortSignal linked to the external one.
    const config = lastStreamParams!.config as Record<string, unknown>;
    const apiSignal = config.abortSignal as AbortSignal;
    expect(apiSignal).toBeInstanceOf(AbortSignal);
    // When the caller hasn't aborted, the API signal should also be non-aborted.
    expect(apiSignal.aborted).toBe(false);
  });

  test("propagates pre-aborted signal in config", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];
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
    const config = lastStreamParams!.config as Record<string, unknown>;
    const apiSignal = config.abortSignal as AbortSignal;
    expect(apiSignal.aborted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Thinking blocks are skipped
  // -----------------------------------------------------------------------
  test("skips thinking blocks in message conversion", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    const messages: Message[] = [
      {
        role: "assistant",
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

    const contents = lastStreamParams!.contents as Array<{
      role: string;
      parts: unknown[];
    }>;
    expect(contents).toHaveLength(1);
    // Only the text part, no thinking part
    expect(contents[0].parts).toHaveLength(1);
    expect(contents[0].parts[0]).toEqual({ text: "Hello" });
  });

  // -----------------------------------------------------------------------
  // Empty parts are filtered (message with only thinking blocks)
  // -----------------------------------------------------------------------
  test("filters out messages that produce no parts", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "hmm...",
            signature: "sig",
          } as ContentBlock,
        ],
      },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];

    await provider.sendMessage(messages);

    const contents = lastStreamParams!.contents as Array<{
      role: string;
      parts: unknown[];
    }>;
    // The assistant message with only thinking should be filtered out
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe("user");
  });

  // -----------------------------------------------------------------------
  // API error handling
  // -----------------------------------------------------------------------
  test("wraps ApiError in ProviderError", async () => {
    shouldThrow = new FakeApiError(429, "Rate limit exceeded");

    try {
      await provider.sendMessage([
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ]);
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect((error as Error).message).toContain("Gemini API error (429)");
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
      expect((error as Error).message).toContain("Gemini request failed");
      expect((error as Error).message).toContain("Network failure");
    }
  });

  // -----------------------------------------------------------------------
  // Tagged AbortReason propagation
  // -----------------------------------------------------------------------
  test("attaches tagged abortReason to ProviderError wrapping an ApiError when signal is aborted with a reason", async () => {
    shouldThrow = new FakeApiError(0, "Request was aborted.");
    const controller = new AbortController();
    const reason = createAbortReason("user_cancel", "test:gemini");
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

  test("attaches tagged abortReason to ProviderError wrapping a generic error on abort", async () => {
    shouldThrow = new Error("socket hang up");
    const controller = new AbortController();
    const reason = createAbortReason("preempted_by_new_message", "test:gemini");
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

  test("does not attach abortReason when the signal was aborted with a non-tagged reason", async () => {
    shouldThrow = new FakeApiError(0, "Request was aborted.");
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
  // Model and contents passed correctly
  // -----------------------------------------------------------------------
  test("sends correct model and contents to API", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(lastStreamParams!.model).toBe("gemini-3-flash");
    const contents = lastStreamParams!.contents as Array<{
      role: string;
      parts: unknown[];
    }>;
    expect(contents).toHaveLength(1);
    expect(contents[0]).toEqual({
      role: "user",
      parts: [{ text: "Hi" }],
    });
  });

  // -----------------------------------------------------------------------
  // Empty content response (only function calls)
  // -----------------------------------------------------------------------
  test("handles response with no text content", async () => {
    fakeChunks = [
      functionCallChunk([{ id: "call_1", name: "test", args: {} }]),
      finishChunk("STOP", 10, 5),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "test" }] },
    ]);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("tool_use");
  });

  // -----------------------------------------------------------------------
  // No tools → no tools in config
  // -----------------------------------------------------------------------
  test("does not include tools in config when none provided", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    const config = lastStreamParams!.config as Record<string, unknown>;
    expect(config.tools).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Default usage when no metadata
  // -----------------------------------------------------------------------
  test("returns zero usage when no usageMetadata in chunks", async () => {
    fakeChunks = [{ text: "Hello" }]; // No usage metadata

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  // -----------------------------------------------------------------------
  // Managed transport — constructor configuration
  // -----------------------------------------------------------------------
  test("does not set httpOptions when managedBaseUrl is not provided", () => {
    new GeminiProvider("test-key", "gemini-3-flash");
    expect(lastConstructorOpts).toEqual({ apiKey: "test-key" });
  });

  test("sets httpOptions.baseUrl when managedBaseUrl is provided", () => {
    new GeminiProvider("managed-key", "gemini-3-flash", {
      managedBaseUrl: "https://platform.example.com/v1/runtime-proxy/gemini",
    });
    expect(lastConstructorOpts).toEqual({
      apiKey: "managed-key",
      httpOptions: {
        baseUrl: "https://platform.example.com/v1/runtime-proxy/gemini",
      },
    });
  });

  test("managed transport produces same ProviderResponse shape", async () => {
    const managedProvider = new GeminiProvider(
      "managed-key",
      "gemini-3-flash",
      {
        managedBaseUrl: "https://platform.example.com/v1/runtime-proxy/gemini",
      },
    );

    fakeChunks = [textChunk("Hello from managed"), finishChunk("STOP", 15, 8)];

    const result = await managedProvider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Hello from managed",
    });
    expect(result.model).toBe("gemini-3-flash-001");
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 8 });
    expect(result.stopReason).toBe("STOP");
  });

  test("managed transport handles tool calls correctly", async () => {
    const managedProvider = new GeminiProvider(
      "managed-key",
      "gemini-3-flash",
      {
        managedBaseUrl: "https://platform.example.com/v1/runtime-proxy/gemini",
      },
    );

    fakeChunks = [
      functionCallChunk([
        { id: "call_managed", name: "file_read", args: { path: "/tmp/test" } },
      ]),
      finishChunk("STOP", 10, 15),
    ];

    const result = await managedProvider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Read /tmp/test" }] },
    ]);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "tool_use",
      id: "call_managed",
      name: "file_read",
      input: { path: "/tmp/test" },
    });
  });
});
