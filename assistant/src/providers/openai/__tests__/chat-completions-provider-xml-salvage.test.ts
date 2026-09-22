import { describe, expect, test } from "bun:test";

import {
  OpenAIChatCompletionsProvider,
  type OpenAIChatCompletionsProviderOptions,
} from "../chat-completions-provider.js";

type MockChunkDelta = {
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

type MockChunk = {
  choices: Array<{ delta: MockChunkDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

const BASH_TOOL = {
  name: "bash",
  description: "Run a shell command",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string" },
      activity: { type: "string" },
      timeout_seconds: { type: "number" },
    },
  },
};

const INVOKE_XML = `<invoke name="bash">
<parameter name="command">cd /workspace/example && git status</parameter>
<parameter name="activity">Checking live repo state</parameter>
<parameter name="timeout_seconds">60</parameter>
</invoke>`;

function makeStream(chunks: MockChunk[]): AsyncIterable<MockChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        yield c;
      }
    },
  };
}

function stubProvider(
  chunks: MockChunk[],
  options?: OpenAIChatCompletionsProviderOptions,
  model = "test-model",
): {
  provider: OpenAIChatCompletionsProvider;
  events: Array<{ type: string; text?: string }>;
} {
  const provider = new OpenAIChatCompletionsProvider("test-key", model, options);
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async () => makeStream(chunks),
      },
    },
  };
  return { provider, events: [] };
}

function contentChunks(parts: string[], finishReason = "stop"): MockChunk[] {
  return [
    ...parts.map((content) => ({
      choices: [{ delta: { content } }],
    })),
    {
      choices: [{ delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    },
  ];
}

describe("OpenAIChatCompletionsProvider XML tool-call salvage", () => {
  test("converts streamed invoke XML into a tool_use block and holds it back from text_delta", async () => {
    const { provider, events } = stubProvider(
      contentChunks([
        "Let me actually run the check.\n\n",
        "<inv",
        `oke name="bash">\n`,
        `<parameter name="command">cd /workspace/example && git status</parameter>\n`,
        `<parameter name="activity">Checking live repo state</parameter>\n`,
        `<parameter name="timeout_seconds">60</parameter>\n`,
        "</invoke>",
      ]),
      { salvageXmlToolCalls: true },
    );

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "check the repo" }] }],
      {
        tools: [BASH_TOOL],
        onEvent: (e) => {
          events.push(e as { type: string; text?: string });
        },
      },
    );

    const textDeltas = events
      .filter((e) => e.type === "text_delta")
      .map((e) => e.text ?? "")
      .join("");
    expect(textDeltas).toBe("Let me actually run the check.\n\n");
    expect(textDeltas).not.toContain("<invoke");
    expect(textDeltas).not.toContain("<inv");

    const textBlock = response.content.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(textBlock?.text).toBe("Let me actually run the check.");

    const toolUse = response.content.filter((b) => b.type === "tool_use");
    expect(toolUse).toEqual([
      {
        type: "tool_use",
        id: expect.stringMatching(/^call_/),
        name: "bash",
        input: {
          command: "cd /workspace/example && git status",
          activity: "Checking live repo state",
          timeout_seconds: 60,
        },
      },
    ]);
    expect(response.stopReason).toBe("tool_calls");
  });

  test("salvages invoke XML when parseThinkTags is enabled", async () => {
    const { provider } = stubProvider(
      contentChunks([`Okay.\n${INVOKE_XML}`]),
      { parseThinkTags: true, salvageXmlToolCalls: true },
    );

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { tools: [BASH_TOOL] },
    );

    expect(response.content.some((b) => b.type === "tool_use")).toBe(true);
    const textBlock = response.content.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(textBlock?.text).toBe("Okay.");
  });

  test("leaves XML as text when native tool_calls are already present", async () => {
    const { provider } = stubProvider(
      [
      { choices: [{ delta: { content: `${INVOKE_XML}\n` } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_native",
                  function: {
                    name: "bash",
                    arguments: '{"command":"pwd"}',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
      ],
      { salvageXmlToolCalls: true },
    );

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { tools: [BASH_TOOL] },
    );

    const toolUse = response.content.filter((b) => b.type === "tool_use");
    expect(toolUse).toHaveLength(1);
    expect(toolUse[0]).toMatchObject({
      id: "call_native",
      name: "bash",
      input: { command: "pwd" },
    });
    const textBlock = response.content.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(textBlock?.text).toContain("<invoke");
  });

  test("leaves XML as text when no tools were offered", async () => {
    const { provider, events } = stubProvider(contentChunks([INVOKE_XML]));

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      {
        onEvent: (e) => {
          events.push(e as { type: string; text?: string });
        },
      },
    );

    expect(response.content.some((b) => b.type === "tool_use")).toBe(false);
    expect(
      events
        .filter((e) => e.type === "text_delta")
        .map((e) => e.text ?? "")
        .join(""),
    ).toContain("<invoke");
  });

  test("leaves XML as text when tool_choice is none", async () => {
    const { provider } = stubProvider(contentChunks([INVOKE_XML]), {
      salvageXmlToolCalls: true,
    });

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      {
        tools: [BASH_TOOL],
        config: { tool_choice: { type: "none" } },
      },
    );

    expect(response.content.some((b) => b.type === "tool_use")).toBe(false);
    const textBlock = response.content.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(textBlock?.text).toContain("<invoke");
  });

  test("leaves XML as text on non-DeepSeek models unless salvage is opted in", async () => {
    const { provider } = stubProvider(contentChunks([INVOKE_XML]));

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { tools: [BASH_TOOL] },
    );

    expect(response.content.some((b) => b.type === "tool_use")).toBe(false);
    const textBlock = response.content.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(textBlock?.text).toContain("<invoke");
  });

  test("salvages by default when the model id is DeepSeek", async () => {
    const { provider } = stubProvider(
      contentChunks([INVOKE_XML]),
      undefined,
      "accounts/fireworks/models/deepseek-v4-flash-0731",
    );

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { tools: [BASH_TOOL] },
    );

    expect(response.content.some((b) => b.type === "tool_use")).toBe(true);
  });

  test("does not salvage DeepSeek when salvageXmlToolCalls is false", async () => {
    const { provider } = stubProvider(
      contentChunks([INVOKE_XML]),
      { salvageXmlToolCalls: false },
      "accounts/fireworks/models/deepseek-v4-flash-0731",
    );

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { tools: [BASH_TOOL] },
    );

    expect(response.content.some((b) => b.type === "tool_use")).toBe(false);
    const textBlock = response.content.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(textBlock?.text).toContain("<invoke");
  });
});
