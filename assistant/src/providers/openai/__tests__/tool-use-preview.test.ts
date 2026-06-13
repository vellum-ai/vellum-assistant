import { describe, expect, test } from "bun:test";

import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";
import { OpenAIResponsesProvider } from "../responses-provider.js";

/**
 * Both OpenAI-compatible providers must emit `tool_use_preview_start` as soon
 * as a tool call's identity (id + name) is known in the stream — before its
 * arguments finish — mirroring the Anthropic client's tool preview lifecycle
 * (see `tool-preview-lifecycle.test.ts`). The preview's `toolUseId` must match
 * the id of the final `tool_use` content block so clients can upgrade the
 * preview block in place.
 */

type CapturedEvent = {
  type: string;
  toolUseId?: string;
  toolName?: string;
};

function makeStream<T>(chunks: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

async function collectEvents(
  provider: OpenAIChatCompletionsProvider | OpenAIResponsesProvider,
): Promise<{
  events: CapturedEvent[];
  content: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
}> {
  const events: CapturedEvent[] = [];
  const response = await provider.sendMessage(
    [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    { onEvent: (e) => events.push(e as CapturedEvent) },
  );
  return {
    events,
    content: response.content as Array<{
      type: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>,
  };
}

describe("OpenAIChatCompletionsProvider tool_use_preview_start", () => {
  function stubProvider(chunks: unknown[]): OpenAIChatCompletionsProvider {
    const provider = new OpenAIChatCompletionsProvider(
      "test-key",
      "test-model",
    );
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async () => makeStream(chunks),
        },
      },
    };
    return provider;
  }

  test("emits preview once per tool call, before arguments finish, with the final tool_use id", async () => {
    const provider = stubProvider([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  function: { name: "write_file", arguments: "" },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"path":"a.txt",' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"content":"hello"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
    ]);

    const { events, content } = await collectEvents(provider);
    const previews = events.filter((e) => e.type === "tool_use_preview_start");
    expect(previews).toEqual([
      {
        type: "tool_use_preview_start",
        toolUseId: "call_abc",
        toolName: "write_file",
      },
    ]);

    const toolUse = content.find((b) => b.type === "tool_use");
    expect(toolUse?.id).toBe("call_abc");
    expect(toolUse?.input).toEqual({ path: "a.txt", content: "hello" });
  });

  test("emits one preview per parallel tool call", async () => {
    const provider = stubProvider([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "tool_a", arguments: "{}" },
                },
                {
                  index: 1,
                  id: "call_2",
                  function: { name: "tool_b", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
    ]);

    const { events } = await collectEvents(provider);
    const previews = events.filter((e) => e.type === "tool_use_preview_start");
    expect(previews.map((p) => [p.toolUseId, p.toolName])).toEqual([
      ["call_1", "tool_a"],
      ["call_2", "tool_b"],
    ]);
  });

  test("emits no preview when the stream has no tool calls", async () => {
    const provider = stubProvider([
      { choices: [{ delta: { content: "plain text" } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
    ]);

    const { events } = await collectEvents(provider);
    expect(
      events.filter((e) => e.type === "tool_use_preview_start"),
    ).toHaveLength(0);
  });
});

describe("OpenAIResponsesProvider tool_use_preview_start", () => {
  function stubProvider(chunks: unknown[]): OpenAIResponsesProvider {
    const provider = new OpenAIResponsesProvider("test-key", "test-model");
    (provider as unknown as { client: unknown }).client = {
      responses: {
        create: async () => makeStream(chunks),
      },
    };
    return provider;
  }

  test("emits preview at output_item.added, before arguments stream, with the final tool_use id", async () => {
    const provider = stubProvider([
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "item_1",
          call_id: "call_xyz",
          name: "write_file",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item_1",
        delta: '{"path":"a.txt"}',
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "item_1",
        arguments: '{"path":"a.txt"}',
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      },
    ]);

    const { events, content } = await collectEvents(provider);
    const previews = events.filter((e) => e.type === "tool_use_preview_start");
    expect(previews).toEqual([
      {
        type: "tool_use_preview_start",
        toolUseId: "call_xyz",
        toolName: "write_file",
      },
    ]);

    const toolUse = content.find((b) => b.type === "tool_use");
    expect(toolUse?.id).toBe("call_xyz");
    expect(toolUse?.input).toEqual({ path: "a.txt" });
  });

  test("emits no preview for non-function output items", async () => {
    const provider = stubProvider([
      {
        type: "response.output_item.added",
        item: { type: "web_search_call", id: "ws_1" },
      },
      { type: "response.output_text.delta", delta: "results" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      },
    ]);

    const { events } = await collectEvents(provider);
    expect(
      events.filter((e) => e.type === "tool_use_preview_start"),
    ).toHaveLength(0);
  });
});
