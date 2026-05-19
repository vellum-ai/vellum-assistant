import { describe, expect, test } from "bun:test";

import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";

type ReasoningDetail = {
  type?: string;
  summary?: string | null;
  text?: string | null;
};

type MockChunkDelta = {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: ReasoningDetail[] | null;
};

type MockChunk = {
  choices: Array<{ delta: MockChunkDelta; finish_reason?: string | null }>;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
};

function makeStream(chunks: MockChunk[]): AsyncIterable<MockChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function stubProvider(chunks: MockChunk[]): {
  provider: OpenAIChatCompletionsProvider;
  events: Array<{ type: string; thinking?: string; text?: string }>;
} {
  const provider = new OpenAIChatCompletionsProvider("test-key", "test-model");
  // Swap the SDK client for a stub whose chat.completions.create returns our
  // canned async iterable.
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async () => makeStream(chunks),
      },
    },
  };
  const events: Array<{ type: string; thinking?: string; text?: string }> = [];
  (provider as unknown as { __events: typeof events }).__events = events;
  return { provider, events };
}

async function runStream(
  provider: OpenAIChatCompletionsProvider,
  events: Array<{ type: string; thinking?: string; text?: string }>,
): Promise<{
  thinking: string;
}> {
  const response = await provider.sendMessage(
    [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    undefined,
    undefined,
    {
      onEvent: (e) => {
        events.push(e as { type: string; thinking?: string; text?: string });
      },
    },
  );
  const thinkingBlock = response.content.find((b) => b.type === "thinking") as
    | { type: "thinking"; thinking: string }
    | undefined;
  return { thinking: thinkingBlock?.thinking ?? "" };
}

describe("OpenAIChatCompletionsProvider reasoning parsing", () => {
  test("emits flat reasoning_content once (Fireworks/DeepSeek/Together/Groq shape)", async () => {
    const { provider, events } = stubProvider([
      { choices: [{ delta: { reasoning_content: "hello " } }] },
      { choices: [{ delta: { reasoning_content: "world" } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
    ]);
    const { thinking } = await runStream(provider, events);
    const deltas = events.filter((e) => e.type === "thinking_delta");
    expect(deltas.map((d) => d.thinking)).toEqual(["hello ", "world"]);
    expect(thinking).toBe("hello world");
  });

  test("emits flat reasoning once (OpenRouter non-Kimi shape)", async () => {
    const { provider, events } = stubProvider([
      { choices: [{ delta: { reasoning: "step " } }] },
      { choices: [{ delta: { reasoning: "two" } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
    ]);
    const { thinking } = await runStream(provider, events);
    const deltas = events.filter((e) => e.type === "thinking_delta");
    expect(deltas.map((d) => d.thinking)).toEqual(["step ", "two"]);
    expect(thinking).toBe("step two");
  });

  test("emits reasoning_details once when only details present", async () => {
    const { provider, events } = stubProvider([
      {
        choices: [
          {
            delta: {
              reasoning_details: [{ type: "reasoning.text", text: "alpha " }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              reasoning_details: [
                { type: "reasoning.summary", summary: "beta" },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
    ]);
    const { thinking } = await runStream(provider, events);
    const deltas = events.filter((e) => e.type === "thinking_delta");
    expect(deltas.map((d) => d.thinking)).toEqual(["alpha ", "beta"]);
    expect(thinking).toBe("alpha beta");
  });

  test("skips reasoning.encrypted entries entirely", async () => {
    const { provider, events } = stubProvider([
      {
        choices: [
          {
            delta: {
              reasoning_details: [
                { type: "reasoning.encrypted", text: "opaque" },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
    ]);
    const { thinking } = await runStream(provider, events);
    const deltas = events.filter((e) => e.type === "thinking_delta");
    expect(deltas).toEqual([]);
    expect(thinking).toBe("");
  });

  test("falls back to flat reasoning when details carry only encrypted entries", async () => {
    const { provider, events } = stubProvider([
      {
        choices: [
          {
            delta: {
              reasoning: "visible ",
              reasoning_details: [
                { type: "reasoning.encrypted", text: "opaque" },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
    ]);
    const { thinking } = await runStream(provider, events);
    const deltas = events.filter((e) => e.type === "thinking_delta");
    expect(deltas.map((d) => d.thinking)).toEqual(["visible "]);
    expect(thinking).toBe("visible ");
  });

  test("does NOT double-emit when Kimi K2.6 mirrors text into both fields", async () => {
    // OpenRouter Kimi K2.6 with `reasoning.summary` set sends the same token
    // in both `delta.reasoning` and `delta.reasoning_details[].text`. The
    // structured field is preferred and the flat field is skipped, so each
    // token appears exactly once in the output stream.
    const { provider, events } = stubProvider([
      {
        choices: [
          {
            delta: {
              reasoning: "it ",
              reasoning_details: [{ type: "reasoning.text", text: "it " }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              reasoning: "worked",
              reasoning_details: [{ type: "reasoning.text", text: "worked" }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              reasoning: "!",
              reasoning_details: [{ type: "reasoning.text", text: "!" }],
            },
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 3 },
      },
    ]);
    const { thinking } = await runStream(provider, events);
    const deltas = events.filter((e) => e.type === "thinking_delta");
    expect(deltas.map((d) => d.thinking)).toEqual(["it ", "worked", "!"]);
    expect(thinking).toBe("it worked!");
  });
});
