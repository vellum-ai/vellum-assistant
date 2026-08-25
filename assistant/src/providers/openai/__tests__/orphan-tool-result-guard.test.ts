/**
 * Serialization guard for orphaned tool results on the OpenAI providers.
 *
 * Both transports validate pairing server-side: the Responses API rejects a
 * `function_call_output` whose `call_id` was not emitted as a `function_call`
 * earlier in the request, and the Chat Completions API rejects a tool-role
 * message whose `tool_call_id` is not in a preceding assistant message's
 * `tool_calls`. A `tool_result` with no backward match in the request (e.g.
 * its `tool_use` truncated away) is therefore degraded into plain user text
 * with an `[orphaned tool result]` prefix, preserving the information while
 * keeping the request valid. Paired results serialize unchanged.
 */
import { describe, expect, test } from "bun:test";

import type { Message } from "../../types.js";
import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";
import { OpenAIResponsesProvider } from "../responses-provider.js";

// ---------------------------------------------------------------------------
// Responses transport harness
// ---------------------------------------------------------------------------

type ResponsesStreamEvent = { type: string; [key: string]: unknown };

const RESPONSES_OK_EVENTS: ResponsesStreamEvent[] = [
  { type: "response.output_text.delta", delta: "ok" },
  {
    type: "response.completed",
    response: {
      model: "gpt-5.2",
      status: "completed",
      output: [],
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  },
];

function makeEventStream(
  events: ResponsesStreamEvent[],
): AsyncIterable<ResponsesStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

/** Swap `responses.create` for a canned stream that records request params. */
function stubResponsesCreate(provider: OpenAIResponsesProvider): {
  input: () => unknown[];
} {
  let captured: unknown;
  const inner = provider as unknown as {
    client: {
      responses: {
        create: (
          params: unknown,
        ) => Promise<AsyncIterable<ResponsesStreamEvent>>;
      };
    };
  };
  inner.client.responses.create = async (params) => {
    captured = params;
    return makeEventStream(RESPONSES_OK_EVENTS);
  };
  return {
    input: () => (captured as { input: unknown[] }).input,
  };
}

// ---------------------------------------------------------------------------
// Chat Completions transport harness
// ---------------------------------------------------------------------------

type ChatChunk = {
  choices: Array<{
    delta: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

const CHAT_OK_CHUNKS: ChatChunk[] = [
  {
    choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  },
];

function makeChunkStream(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

type ChatMessageParam = {
  role: string;
  content: string | Array<Record<string, unknown>>;
  tool_call_id?: string;
};

/** Swap chat `create` for a canned stream that records request params. */
function stubChatCreate(provider: OpenAIChatCompletionsProvider): {
  messages: () => ChatMessageParam[];
} {
  let captured: unknown;
  const inner = provider as unknown as {
    client: {
      chat: {
        completions: {
          create: (params: unknown) => Promise<AsyncIterable<ChatChunk>>;
        };
      };
    };
  };
  inner.client.chat.completions.create = async (params) => {
    captured = params;
    return makeChunkStream(CHAT_OK_CHUNKS);
  };
  return {
    messages: () => (captured as { messages: ChatMessageParam[] }).messages,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Persisted tool id shapes: `call_` is the Responses-native pass-through
 * (conversations that always ran on this transport), `toolu_` is an
 * Anthropic-shaped history routed to an OpenAI call site (cross-provider
 * routing, e.g. a compaction call over imported history). The guard must be
 * id-format-agnostic, so every case runs across both.
 */
const ID_SHAPES = [
  { label: "call_ ids", pairedId: "call_paired", orphanId: "call_orphan" },
  { label: "toolu_ ids", pairedId: "toolu_paired", orphanId: "toolu_orphan" },
] as const;

/** History whose tool_result is paired with a preceding tool_use. */
function pairedHistory(id: string, result = "file contents"): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "Read the file" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name: "file_read",
          input: { path: "/tmp/a" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: result,
        },
      ],
    },
  ];
}

/**
 * History whose leading tool_result has no matching tool_use anywhere in
 * the request (the shape a pairing-blind front truncation produces).
 */
function orphanHistory(id: string): Message[] {
  return [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: "stranded output",
        },
        { type: "text", text: "continue from here" },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "continuing" }] },
    { role: "user", content: [{ type: "text", text: "thanks" }] },
  ];
}

/**
 * A tool_result that arrives BEFORE its tool_use in the request order. The
 * API contract only accepts backward matches, so this is orphaned too.
 */
function forwardReferenceHistory(): Message[] {
  return [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_later",
          content: "premature output",
        },
        { type: "text", text: "odd ordering" },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_later",
          name: "file_read",
          input: { path: "/tmp/b" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_later",
          content: "real output",
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Responses transport
// ---------------------------------------------------------------------------

describe("OpenAIResponsesProvider orphan tool_result guard", () => {
  for (const shape of ID_SHAPES) {
    test(`emits function_call_output for a paired tool_result (${shape.label})`, async () => {
      const provider = new OpenAIResponsesProvider("sk-test", "gpt-5.2");
      const stub = stubResponsesCreate(provider);

      await provider.sendMessage(pairedHistory(shape.pairedId));

      const input = stub.input() as Array<Record<string, unknown>>;
      expect(input).toHaveLength(3);
      expect(input[1]).toEqual({
        type: "function_call",
        call_id: shape.pairedId,
        name: "file_read",
        arguments: '{"path":"/tmp/a"}',
      });
      expect(input[2]).toEqual({
        type: "function_call_output",
        call_id: shape.pairedId,
        output: "file contents",
      });
    });

    test(`degrades an orphaned tool_result to user text instead of function_call_output (${shape.label})`, async () => {
      const provider = new OpenAIResponsesProvider("sk-test", "gpt-5.2");
      const stub = stubResponsesCreate(provider);

      await provider.sendMessage(orphanHistory(shape.orphanId));

      const input = stub.input() as Array<Record<string, unknown>>;
      // No function_call_output items at all: the only tool_result was
      // orphaned.
      expect(input.some((item) => item.type === "function_call_output")).toBe(
        false,
      );

      // The orphan's content is preserved as prefixed text inside the user
      // message, alongside the message's own text.
      const firstUser = input[0] as {
        type: string;
        role: string;
        content: Array<{ type: string; text?: string }>;
      };
      expect(firstUser.type).toBe("message");
      expect(firstUser.role).toBe("user");
      const texts = firstUser.content.map((part) => part.text ?? "");
      expect(texts).toContain("continue from here");
      expect(texts).toContain("[orphaned tool result] stranded output");
    });
  }

  test("treats a forward-referencing tool_result as orphaned, keeps the backward match", async () => {
    const provider = new OpenAIResponsesProvider("sk-test", "gpt-5.2");
    const stub = stubResponsesCreate(provider);

    await provider.sendMessage(forwardReferenceHistory());

    const input = stub.input() as Array<Record<string, unknown>>;
    const outputs = input.filter(
      (item) => item.type === "function_call_output",
    );
    // Only the tool_result AFTER the function_call serializes as an output.
    expect(outputs).toEqual([
      {
        type: "function_call_output",
        call_id: "call_later",
        output: "real output",
      },
    ]);
    // The premature result is degraded into the first user message.
    const firstUser = input[0] as {
      content: Array<{ type: string; text?: string }>;
    };
    const texts = firstUser.content.map((part) => part.text ?? "");
    expect(texts).toContain("[orphaned tool result] premature output");
  });
});

// ---------------------------------------------------------------------------
// Chat Completions transport
// ---------------------------------------------------------------------------

describe("OpenAIChatCompletionsProvider orphan tool_result guard", () => {
  function makeProvider(): OpenAIChatCompletionsProvider {
    return new OpenAIChatCompletionsProvider("sk-test", "test-model", {
      providerName: "openai",
      providerLabel: "OpenAI",
    });
  }

  for (const shape of ID_SHAPES) {
    test(`emits a tool message for a paired tool_result (${shape.label})`, async () => {
      const provider = makeProvider();
      const stub = stubChatCreate(provider);

      await provider.sendMessage(pairedHistory(shape.pairedId));

      const sent = stub.messages();
      const toolMessages = sent.filter((message) => message.role === "tool");
      expect(toolMessages).toEqual([
        {
          role: "tool",
          tool_call_id: shape.pairedId,
          content: "file contents",
        },
      ]);
    });

    test(`degrades an orphaned tool_result to user text instead of a tool message (${shape.label})`, async () => {
      const provider = makeProvider();
      const stub = stubChatCreate(provider);

      await provider.sendMessage(orphanHistory(shape.orphanId));

      const sent = stub.messages();
      expect(sent.some((message) => message.role === "tool")).toBe(false);

      const firstUser = sent.find((message) => message.role === "user");
      expect(firstUser).toBeDefined();
      const content = firstUser!.content;
      const texts = Array.isArray(content)
        ? content.map((part) => (part.text as string) ?? "")
        : [content];
      expect(texts).toContain("continue from here");
      expect(texts).toContain("[orphaned tool result] stranded output");
    });
  }

  test("treats a forward-referencing tool_result as orphaned, keeps the backward match", async () => {
    const provider = makeProvider();
    const stub = stubChatCreate(provider);

    await provider.sendMessage(forwardReferenceHistory());

    const sent = stub.messages();
    const toolMessages = sent.filter((message) => message.role === "tool");
    expect(toolMessages).toEqual([
      {
        role: "tool",
        tool_call_id: "call_later",
        content: "real output",
      },
    ]);
  });

  test("keeps JSON Schema references opaque for Gemini-compatible gateways", async () => {
    const provider = makeProvider();
    const stub = stubChatCreate(provider);
    const schemaResult = JSON.stringify({
      $defs: { LLMProvider: { type: "string" } },
      properties: {
        provider: { $ref: "#/$defs/LLMProvider" },
      },
    });

    await provider.sendMessage(pairedHistory("call_schema", schemaResult));

    const sent = stub.messages();
    const toolMessage = sent.find((message) => message.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(JSON.parse(toolMessage!.content as string)).toEqual({
      output: schemaResult,
    });
  });

  test("leaves ordinary JSON tool results unchanged", async () => {
    const provider = makeProvider();
    const stub = stubChatCreate(provider);
    const ordinaryResult = JSON.stringify({ status: "ok", count: 3 });

    await provider.sendMessage(pairedHistory("call_json", ordinaryResult));

    const sent = stub.messages();
    const toolMessage = sent.find((message) => message.role === "tool");
    expect(toolMessage?.content).toBe(ordinaryResult);
  });
});

// ---------------------------------------------------------------------------
// Cross-transport agreement
// ---------------------------------------------------------------------------

describe("orphan degradation agrees across both OpenAI transports", () => {
  /** Every degraded orphan text a request carried, in request order. */
  async function responsesOrphanTexts(history: Message[]): Promise<string[]> {
    const provider = new OpenAIResponsesProvider("sk-test", "gpt-5.2");
    const stub = stubResponsesCreate(provider);
    await provider.sendMessage(history);
    const input = stub.input() as Array<Record<string, unknown>>;
    return input
      .flatMap((item) =>
        Array.isArray(item.content) ? (item.content as unknown[]) : [],
      )
      .map((part) => (part as { text?: string }).text ?? "")
      .filter((text) => text.startsWith("[orphaned"));
  }

  async function chatOrphanTexts(history: Message[]): Promise<string[]> {
    const provider = new OpenAIChatCompletionsProvider(
      "sk-test",
      "test-model",
      {
        providerName: "openai",
        providerLabel: "OpenAI",
      },
    );
    const stub = stubChatCreate(provider);
    await provider.sendMessage(history);
    return (
      stub
        .messages()
        // A user message carrying a single text part serializes as a plain
        // string on this transport rather than a one-element array.
        .flatMap((message) =>
          Array.isArray(message.content)
            ? (message.content as unknown[]).map(
                (part) => (part as { text?: string }).text ?? "",
              )
            : [String(message.content ?? "")],
        )
        .filter((text) => text.startsWith("[orphaned"))
    );
  }

  // The detection rule and the degraded wording live in one shared helper
  // (`serializeToolResult`), so the two transports cannot drift into
  // different markers for the same input. Byte equality is the assertion:
  // re-inlining the rule in one converter and editing it there fails here,
  // which is the regression this pins.
  test("both transports degrade the same orphan to byte-identical text", async () => {
    const history = orphanHistory("call_orphan");

    const [fromResponses, fromChat] = await Promise.all([
      responsesOrphanTexts(history),
      chatOrphanTexts(history),
    ]);

    expect(fromResponses).toEqual(["[orphaned tool result] stranded output"]);
    expect(fromChat).toEqual(fromResponses);
  });

  test("both transports carry an executor failure into the same degraded text", async () => {
    // `is_error` prefixing is part of the shared payload rule, so it must
    // survive degradation identically on both transports.
    const history: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_orphan",
            content: "boom",
            is_error: true,
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "continuing" }] },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ];

    const [fromResponses, fromChat] = await Promise.all([
      responsesOrphanTexts(history),
      chatOrphanTexts(history),
    ]);

    expect(fromResponses).toEqual(["[orphaned tool result] [ERROR] boom"]);
    expect(fromChat).toEqual(fromResponses);
  });
});
