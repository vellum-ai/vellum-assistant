import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ContentBlock,
  Message,
  ProviderEvent,
  ToolDefinition,
} from "../providers/types.js";
import { ContextOverflowError } from "../providers/types.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { ProviderError, type ProviderErrorReason } from "../util/errors.js";

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
    content?: {
      parts?: Array<{
        functionCall?: {
          id?: string;
          name?: string;
          args?: Record<string, unknown>;
        };
        thoughtSignature?: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
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
  ThinkingLevel: {
    MINIMAL: "MINIMAL",
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
  },
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
  cached?: number,
): FakeChunk {
  return {
    candidates: [{ finishReason: reason }],
    usageMetadata: {
      promptTokenCount: prompt,
      candidatesTokenCount: output,
      ...(cached !== undefined ? { cachedContentTokenCount: cached } : {}),
    },
    modelVersion: "gemini-3-flash-preview-001",
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

function candidateFunctionCallChunk(
  calls: Array<{
    id?: string;
    name: string;
    args: Record<string, unknown>;
    thoughtSignature?: string;
  }>,
  fallbackCalls?: Array<{
    id?: string;
    name: string;
    args: Record<string, unknown>;
  }>,
): FakeChunk {
  return {
    candidates: [
      {
        content: {
          parts: calls.map((c) => ({
            functionCall: {
              id: c.id,
              name: c.name,
              args: c.args,
            },
            thoughtSignature: c.thoughtSignature,
          })),
        },
      },
    ],
    functionCalls: fallbackCalls?.map((c) => ({
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
    provider = new GeminiProvider("test-api-key", "gemini-3-flash-preview");
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
    expect(result.model).toBe("gemini-3-flash-preview-001");
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
      { systemPrompt: "You are a helpful assistant." },
    );

    const config = lastStreamParams!.config as Record<string, unknown>;
    expect(config.systemInstruction).toBe("You are a helpful assistant.");
  });

  // -----------------------------------------------------------------------
  // Thinking config
  // -----------------------------------------------------------------------
  test("omits thinkingConfig when no thinking config is supplied", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    const config = lastStreamParams!.config as Record<string, unknown>;
    expect(config.thinkingConfig).toBeUndefined();
  });

  test("maps wire { type: 'adaptive', level, streamThinking } to Gemini thinkingConfig", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      {
        config: {
          thinking: {
            type: "adaptive",
            level: "high",
            streamThinking: false,
          },
        },
      },
    );

    const config = lastStreamParams!.config as Record<string, unknown>;
    expect(config.thinkingConfig).toEqual({
      thinkingLevel: "HIGH",
      includeThoughts: false,
    });
  });

  test("maps wire { type: 'disabled' } to MINIMAL thinking level", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      { config: { thinking: { type: "disabled" } } },
    );

    const config = lastStreamParams!.config as Record<string, unknown>;
    expect(config.thinkingConfig).toEqual({
      thinkingLevel: "MINIMAL",
      includeThoughts: false,
    });
  });

  test("omits thinkingConfig for models that do not support thinking", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    // gemini-2.5-flash-lite has supportsThinking: false in the catalog; the
    // provider must not forward thinking params even when a thinking config is
    // supplied (gemini is in THINKING_AWARE_PROVIDERS, so retry.ts no longer
    // strips them).
    const liteProvider = new GeminiProvider(
      "test-api-key",
      "gemini-2.5-flash-lite",
    );
    await liteProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      {
        config: {
          thinking: { type: "adaptive", level: "high", streamThinking: false },
        },
      },
    );

    const config = lastStreamParams!.config as Record<string, unknown>;
    expect(config.thinkingConfig).toBeUndefined();
  });

  test("omits thinkingConfig when wire shape is adaptive with no extras", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      { config: { thinking: { type: "adaptive" } } },
    );

    const config = lastStreamParams!.config as Record<string, unknown>;
    // No level/streamThinking → omit so Google's per-model default applies
    // (Gemini 3.x defaults to "medium" with dynamic thinking).
    expect(config.thinkingConfig).toBeUndefined();
  });

  // Gemini 3.x Pro models reject MINIMAL and cannot disable thinking, so the
  // provider must never send a level below the Pro floor ("low") and must pin
  // a supported default when none is requested.
  test("Pro: adaptive with no level pins the documented default (high)", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    const proProvider = new GeminiProvider(
      "test-api-key",
      "gemini-3.1-pro-preview",
    );
    await proProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      { config: { thinking: { type: "adaptive", streamThinking: true } } },
    );

    const config = lastStreamParams!.config as Record<string, unknown>;
    expect(config.thinkingConfig).toEqual({
      thinkingLevel: "HIGH",
      includeThoughts: true,
    });
  });

  test("Pro: disabled maps to the LOW floor, not MINIMAL", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    const proProvider = new GeminiProvider(
      "test-api-key",
      "gemini-3.1-pro-preview",
    );
    await proProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      { config: { thinking: { type: "disabled" } } },
    );

    const config = lastStreamParams!.config as Record<string, unknown>;
    expect(config.thinkingConfig).toEqual({
      thinkingLevel: "LOW",
      includeThoughts: false,
    });
  });

  test("Pro: an explicit minimal level is clamped up to LOW", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    const proProvider = new GeminiProvider(
      "test-api-key",
      "gemini-3.1-pro-preview-customtools",
    );
    await proProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      {
        config: {
          thinking: {
            type: "adaptive",
            level: "minimal",
            streamThinking: false,
          },
        },
      },
    );

    const config = lastStreamParams!.config as Record<string, unknown>;
    expect(config.thinkingConfig).toEqual({
      thinkingLevel: "LOW",
      includeThoughts: false,
    });
  });

  test("Pro: a supported explicit level passes through unchanged", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    const proProvider = new GeminiProvider(
      "test-api-key",
      "gemini-3.1-pro-preview",
    );
    await proProvider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      {
        config: {
          thinking: { type: "adaptive", level: "medium", streamThinking: true },
        },
      },
    );

    const config = lastStreamParams!.config as Record<string, unknown>;
    expect(config.thinkingConfig).toEqual({
      thinkingLevel: "MEDIUM",
      includeThoughts: true,
    });
  });

  test("non-Pro: adaptive with no level keeps Google's default (only includeThoughts)", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    // Default provider is gemini-3-flash-preview (Flash). Flash accepts MINIMAL
    // and resolves an absent level via Google's per-model default, so we leave
    // thinkingLevel unset and only forward the streaming preference.
    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      { config: { thinking: { type: "adaptive", streamThinking: true } } },
    );

    const config = lastStreamParams!.config as Record<string, unknown>;
    expect(config.thinkingConfig).toEqual({ includeThoughts: true });
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
      { tools: tools },
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

  test("captures thought signature from streamed candidate function call parts", async () => {
    fakeChunks = [
      candidateFunctionCallChunk(
        [
          {
            id: "call_signed",
            name: "file_read",
            args: { path: "/tmp/test" },
            thoughtSignature: "signed-thought-1",
          },
        ],
        [
          {
            id: "call_duplicate",
            name: "file_read",
            args: { path: "/tmp/dup" },
          },
        ],
      ),
      finishChunk("STOP", 10, 15),
    ];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Read /tmp/test" }] },
    ]);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "tool_use",
      id: "call_signed",
      name: "file_read",
      input: { path: "/tmp/test" },
      providerMetadata: {
        gemini: { thoughtSignature: "signed-thought-1" },
      },
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

  test("preserves parallel candidate function call order and only captured signatures", async () => {
    fakeChunks = [
      candidateFunctionCallChunk([
        {
          id: "call_1",
          name: "file_read",
          args: { path: "/a" },
          thoughtSignature: "signed-thought-1",
        },
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
      providerMetadata: {
        gemini: { thoughtSignature: "signed-thought-1" },
      },
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
    expect(contents[1].parts[0]).toMatchObject({
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

  function toolResultWithAudio(mediaType: string, data: string): Message[] {
    return [
      { role: "user", content: [{ type: "text", text: "Read clip" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_audio",
            name: "file_read",
            input: { path: "/tmp/clip" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_audio",
            content: "Audio loaded: /tmp/clip",
            is_error: false,
            contentBlocks: [
              {
                type: "file",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data,
                  filename: "clip",
                },
              },
            ],
          },
        ],
      },
    ];
  }

  test("sends tool_result audio as a separate inlineData Content (audio/mpeg → audio/mp3)", async () => {
    fakeChunks = [textChunk("I hear a bell"), finishChunk("STOP", 20, 10)];

    await provider.sendMessage(toolResultWithAudio("audio/mpeg", "QUJDREVG"));

    const contents = lastStreamParams!.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    // user, model(functionCall), user(functionResponse), user(audio inlineData)
    expect(contents).toHaveLength(4);
    expect(contents[2].parts[0]).toMatchObject({
      functionResponse: { name: "file_read" },
    });
    // Audio must NOT be mixed into the functionResponse Content.
    expect(contents[2].parts.some((p) => "inlineData" in p)).toBe(false);
    expect(contents[3].role).toBe("user");
    expect(contents[3].parts[0]).toEqual({
      inlineData: { mimeType: "audio/mp3", data: "QUJDREVG" },
    });
  });

  test("drops unsupported tool_result audio (m4a) — no extra Content", async () => {
    fakeChunks = [textChunk("ok"), finishChunk("STOP", 10, 2)];

    await provider.sendMessage(toolResultWithAudio("audio/x-m4a", "QUJDREVG"));

    const contents = lastStreamParams!.contents as Array<{ parts: unknown[] }>;
    expect(contents).toHaveLength(3); // no separate media Content
  });

  test("degrades oversize tool_result audio into the functionResponse output", async () => {
    fakeChunks = [textChunk("ok"), finishChunk("STOP", 10, 2)];
    const oversize = "A".repeat(17_000_000); // > 12 MB raw

    await provider.sendMessage(toolResultWithAudio("audio/mpeg", oversize));

    const contents = lastStreamParams!.contents as Array<{
      parts: Array<{ functionResponse?: { response: { output: string } } }>;
    }>;
    expect(contents).toHaveLength(3); // no inlineData Content
    expect(contents[2].parts[0].functionResponse?.response.output).toContain(
      "too large",
    );
  });

  test("replays Gemini thought signatures on serialized tool_use history", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Read /tmp/test" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_signed",
            name: "file_read",
            input: { path: "/tmp/test" },
            providerMetadata: {
              gemini: { thoughtSignature: "signed-thought-1" },
            },
          },
          {
            type: "tool_use",
            id: "call_unsigned",
            name: "file_read",
            input: { path: "/tmp/other" },
          },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const contents = lastStreamParams!.contents as Array<{
      role: string;
      parts: Array<{
        functionCall?: unknown;
        thoughtSignature?: string;
      }>;
    }>;
    expect(contents[1].parts).toEqual([
      {
        functionCall: {
          name: "file_read",
          args: { path: "/tmp/test" },
        },
        thoughtSignature: "signed-thought-1",
      },
      {
        functionCall: {
          name: "file_read",
          args: { path: "/tmp/other" },
        },
      },
    ]);
  });

  test("adds Gemini 3 fallback thought signature to old unsigned tool_use history", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    const overrideProvider = new GeminiProvider(
      "test-api-key",
      "gemini-2.5-flash",
    );
    await overrideProvider.sendMessage(
      [
        { role: "user", content: [{ type: "text", text: "Read files" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "file_read",
              input: { path: "/a" },
            },
            {
              type: "tool_use",
              id: "call_2",
              name: "file_read",
              input: { path: "/b" },
            },
          ],
        },
      ],
      { config: { model: "models/gemini-3.1-pro-preview" } },
    );

    const contents = lastStreamParams!.contents as Array<{
      role: string;
      parts: Array<{
        functionCall?: unknown;
        thoughtSignature?: string;
      }>;
    }>;
    expect(contents[1].parts).toEqual([
      {
        functionCall: {
          name: "file_read",
          args: { path: "/a" },
        },
        thoughtSignature: "context_engineering_is_the_way_to_go",
      },
      {
        functionCall: {
          name: "file_read",
          args: { path: "/b" },
        },
      },
    ]);
  });

  test("does not add fallback thought signature for Gemini 2.5 tool_use history", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    const gemini25Provider = new GeminiProvider(
      "test-api-key",
      "gemini-2.5-flash",
    );
    await gemini25Provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Read /tmp/test" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_unsigned",
            name: "file_read",
            input: { path: "/tmp/test" },
          },
        ],
      },
    ]);

    const contents = lastStreamParams!.contents as Array<{
      role: string;
      parts: unknown[];
    }>;
    expect(contents[1].parts).toEqual([
      {
        functionCall: {
          name: "file_read",
          args: { path: "/tmp/test" },
        },
      },
    ]);
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
  // Audio content (native Gemini audio input)
  // -----------------------------------------------------------------------
  test("sends audio file blocks inline, normalizing audio/mpeg → audio/mp3", async () => {
    fakeChunks = [textChunk("I hear a bell"), finishChunk("STOP", 100, 5)];

    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What do you hear?" },
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "audio/mpeg",
              data: "QUJDREVG",
              filename: "clip.mp3",
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
    expect(contents[0].parts).toHaveLength(2);
    expect(contents[0].parts[1]).toEqual({
      inlineData: { mimeType: "audio/mp3", data: "QUJDREVG" },
    });
  });

  test("sends supported audio types inline unchanged", async () => {
    for (const mime of ["audio/wav", "audio/ogg", "audio/flac", "audio/aac"]) {
      fakeChunks = [textChunk("ok"), finishChunk("STOP", 10, 2)];
      await provider.sendMessage([
        {
          role: "user",
          content: [
            {
              type: "file",
              source: {
                type: "base64",
                media_type: mime,
                data: "QUJDREVG",
                filename: `clip.${mime.split("/")[1]}`,
              },
            },
          ],
        },
      ]);
      const contents = lastStreamParams!.contents as Array<{
        parts: unknown[];
      }>;
      expect(contents[0].parts[0]).toEqual({
        inlineData: { mimeType: mime, data: "QUJDREVG" },
      });
    }
  });

  test("degrades unsupported audio (m4a/mp4) to a text placeholder", async () => {
    for (const mime of ["audio/x-m4a", "audio/mp4"]) {
      fakeChunks = [textChunk("ok"), finishChunk("STOP", 10, 2)];
      await provider.sendMessage([
        {
          role: "user",
          content: [
            {
              type: "file",
              source: {
                type: "base64",
                media_type: mime,
                data: "QUJDREVG",
                filename: "memo.m4a",
              },
            },
          ],
        },
      ]);
      const parts = (
        lastStreamParams!.contents as Array<{ parts: unknown[] }>
      )[0].parts;
      expect(parts[0]).toHaveProperty("text");
      expect(parts[0]).not.toHaveProperty("inlineData");
      expect((parts[0] as { text: string }).text).toContain("memo.m4a");
    }
  });

  test("degrades oversize inline audio to a text placeholder", async () => {
    fakeChunks = [textChunk("ok"), finishChunk("STOP", 10, 2)];
    // base64 length * 3/4 must exceed the 12 MB inline cap.
    const oversize = "A".repeat(17_000_000);

    await provider.sendMessage([
      {
        role: "user",
        content: [
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "audio/mpeg",
              data: oversize,
              filename: "long.mp3",
            },
          },
        ],
      },
    ]);

    const parts = (lastStreamParams!.contents as Array<{ parts: unknown[] }>)[0]
      .parts;
    expect(parts[0]).not.toHaveProperty("inlineData");
    expect((parts[0] as { text: string }).text).toContain("too large");
    expect((parts[0] as { text: string }).text).toContain("long.mp3");
  });

  // -----------------------------------------------------------------------
  // max_tokens config
  // -----------------------------------------------------------------------
  test("passes max_tokens as maxOutputTokens", async () => {
    fakeChunks = [textChunk("OK"), finishChunk("STOP", 10, 2)];

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
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
        { signal: controller.signal },
      );
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).abortReason).toBeUndefined();
    }
  });

  // -----------------------------------------------------------------------
  // Error reason mapping
  // -----------------------------------------------------------------------
  async function reasonForApiError(
    status: number,
    message: string,
  ): Promise<ProviderErrorReason | undefined> {
    shouldThrow = new FakeApiError(status, message);
    try {
      await provider.sendMessage([
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ]);
      throw new Error("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      return (error as ProviderError).reason;
    }
  }

  test("maps 401 / UNAUTHENTICATED to invalid_credentials", async () => {
    expect(await reasonForApiError(401, "API key not valid")).toBe(
      "invalid_credentials",
    );
    expect(await reasonForApiError(0, "UNAUTHENTICATED: bad key")).toBe(
      "invalid_credentials",
    );
  });

  test("maps a plan/model-restricted 403 to model_restricted", async () => {
    expect(
      await reasonForApiError(
        403,
        "PERMISSION_DENIED: Gemini API model gemini-3-pro is not available on your billing plan",
      ),
    ).toBe("model_restricted");
  });

  test("maps a generic 403 with no model signal to invalid_credentials", async () => {
    expect(
      await reasonForApiError(
        403,
        "PERMISSION_DENIED: The caller does not have permission",
      ),
    ).toBe("invalid_credentials");
  });

  test("maps an IAM 403 on a models/* resource to invalid_credentials, not model_restricted", async () => {
    expect(
      await reasonForApiError(
        403,
        "PERMISSION_DENIED: Permission 'generativelanguage.models.generateContent' denied on resource //generativelanguage.googleapis.com/models/gemini-2.5-pro",
      ),
    ).toBe("invalid_credentials");
  });

  test("maps 404 / NOT_FOUND to model_not_found", async () => {
    expect(
      await reasonForApiError(404, "NOT_FOUND: model does not exist"),
    ).toBe("model_not_found");
  });

  test("maps a plain 429 (no token signal) to rate_limited, not context overflow", async () => {
    shouldThrow = new FakeApiError(
      429,
      "RESOURCE_EXHAUSTED: Quota exceeded for requests per minute",
    );
    try {
      await provider.sendMessage([
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ]);
      throw new Error("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).not.toBeInstanceOf(ContextOverflowError);
      expect((error as ProviderError).reason).toBe("rate_limited");
    }
  });

  test("maps 5xx to server_error, or overloaded when the body says so", async () => {
    expect(await reasonForApiError(500, "Internal error")).toBe("server_error");
    expect(
      await reasonForApiError(
        503,
        "UNAVAILABLE: The model is overloaded. Please try again later.",
      ),
    ).toBe("overloaded");
  });

  test("maps other 4xx to bad_request", async () => {
    expect(await reasonForApiError(400, "INVALID_ARGUMENT: bad field")).toBe(
      "bad_request",
    );
  });

  test("a genuine token-limit 429 still yields ContextOverflowError / context_overflow", async () => {
    shouldThrow = new FakeApiError(
      429,
      "RESOURCE_EXHAUSTED: The input token count (2000000) exceeds the maximum number of tokens allowed (1048576).",
    );
    try {
      await provider.sendMessage([
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ]);
      throw new Error("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextOverflowError);
      expect((error as ProviderError).reason).toBe("context_overflow");
    }
  });

  test("a token-limit 400 still yields ContextOverflowError / context_overflow", async () => {
    shouldThrow = new FakeApiError(
      400,
      "INVALID_ARGUMENT: The prompt is too long; token count exceeds the model's context length.",
    );
    try {
      await provider.sendMessage([
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ]);
      throw new Error("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextOverflowError);
      expect((error as ProviderError).reason).toBe("context_overflow");
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

    expect(lastStreamParams!.model).toBe("gemini-3-flash-preview");
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
  // Implicit prompt caching (cache reads)
  // -----------------------------------------------------------------------
  test("surfaces cachedContentTokenCount as cacheReadInputTokens", async () => {
    // Gemini reports cached tokens as a subset already included in
    // promptTokenCount, so inputTokens stays the inclusive total and the
    // cached subset is reported separately for the discounted cache-read rate.
    fakeChunks = [textChunk("Hi back"), finishChunk("STOP", 100, 20, 30)];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 30,
    });
  });

  test("omits cacheReadInputTokens when no tokens were cached", async () => {
    fakeChunks = [textChunk("Hi back"), finishChunk("STOP", 100, 20, 0)];

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);

    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  // -----------------------------------------------------------------------
  // Managed transport — constructor configuration
  // -----------------------------------------------------------------------
  test("does not set httpOptions when managedBaseUrl is not provided", () => {
    new GeminiProvider("test-key", "gemini-3-flash-preview");
    expect(lastConstructorOpts).toEqual({ apiKey: "test-key" });
  });

  test("sets httpOptions.baseUrl when managedBaseUrl is provided", () => {
    new GeminiProvider("managed-key", "gemini-3-flash-preview", {
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
      "gemini-3-flash-preview",
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
    expect(result.model).toBe("gemini-3-flash-preview-001");
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 8 });
    expect(result.stopReason).toBe("STOP");
  });

  test("managed transport handles tool calls correctly", async () => {
    const managedProvider = new GeminiProvider(
      "managed-key",
      "gemini-3-flash-preview",
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
