import { describe, expect, test } from "bun:test";

import { isPlaceholderSentinelText } from "../../placeholder-sentinels.js";
import {
  EMPTY_ASSISTANT_TURN_PLACEHOLDER,
  OpenAIChatCompletionsProvider,
  type OpenAIChatCompletionsProviderOptions,
} from "../chat-completions-provider.js";

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

function stubProvider(
  chunks: MockChunk[],
  options?: OpenAIChatCompletionsProviderOptions,
): {
  provider: OpenAIChatCompletionsProvider;
  events: Array<{ type: string; thinking?: string; text?: string }>;
  requests: unknown[];
} {
  const provider = new OpenAIChatCompletionsProvider(
    "test-key",
    "test-model",
    options,
  );
  const requests: unknown[] = [];
  // Swap the SDK client for a stub whose chat.completions.create returns our
  // canned async iterable.
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (params: unknown) => {
          requests.push(params);
          return makeStream(chunks);
        },
      },
    },
  };
  const events: Array<{ type: string; thinking?: string; text?: string }> = [];
  (provider as unknown as { __events: typeof events }).__events = events;
  return { provider, events, requests };
}

async function runStream(
  provider: OpenAIChatCompletionsProvider,
  events: Array<{ type: string; thinking?: string; text?: string }>,
): Promise<{
  thinking: string;
}> {
  const response = await provider.sendMessage(
    [{ role: "user", content: [{ type: "text", text: "hi" }] }],
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

  test("round-trips prior assistant thinking as reasoning_content when field is set", async () => {
    const { provider, requests } = stubProvider(
      [
        {
          choices: [{ delta: { content: "continued" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
        },
      ],
      { assistantReasoningField: "reasoning_content" },
    );

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "first question" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden chain state", signature: "" },
          { type: "text", text: "first answer" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "follow up" }] },
    ]);

    const params = requests[0] as {
      messages: Array<{
        role: string;
        content: string | null;
        reasoning_content?: string;
      }>;
    };
    const assistantMsg = params.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toEqual({
      role: "assistant",
      content: "first answer",
      reasoning_content: "hidden chain state",
    });
  });

  test("uses reasoning field for OpenRouter-style round-trip", async () => {
    const { provider, requests } = stubProvider(
      [
        {
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        },
      ],
      { assistantReasoningField: "reasoning" },
    );

    await provider.sendMessage([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "visible summary", signature: "" },
          { type: "text", text: "answer" },
        ],
      },
    ]);

    const params = requests[0] as {
      messages: Array<{
        role: string;
        reasoning?: string;
        reasoning_content?: string;
      }>;
    };
    expect(params.messages[0].reasoning).toBe("visible summary");
    expect(params.messages[0].reasoning_content).toBeUndefined();
  });

  test("drops thinking blocks when assistantReasoningField is unset", async () => {
    const { provider, requests } = stubProvider([
      {
        choices: [{ delta: { content: "reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      },
    ]);

    await provider.sendMessage([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "should be dropped", signature: "" },
          { type: "text", text: "visible" },
        ],
      },
    ]);

    const params = requests[0] as {
      messages: Array<{
        role: string;
        content: string | null;
        reasoning?: string;
        reasoning_content?: string;
      }>;
    };
    const assistantMsg = params.messages[0];
    expect(assistantMsg.content).toBe("visible");
    expect(assistantMsg.reasoning).toBeUndefined();
    expect(assistantMsg.reasoning_content).toBeUndefined();
  });

  test("backfills placeholder content for a reasoning-only assistant turn when enabled", async () => {
    const { provider, requests } = stubProvider(
      [
        {
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        },
      ],
      {
        assistantReasoningField: "reasoning",
        backfillEmptyAssistantContent: true,
      },
    );

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "question" }] },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "truncated chain of thought",
            signature: "",
          },
        ],
      },
    ]);

    const params = requests[0] as {
      messages: Array<{
        role: string;
        content: string | null;
        reasoning?: string;
        tool_calls?: unknown;
      }>;
    };
    const assistantMsg = params.messages.find((m) => m.role === "assistant")!;
    // content or tool_calls must be set; reasoning alone does not satisfy it.
    expect(assistantMsg.content).toBe(EMPTY_ASSISTANT_TURN_PLACEHOLDER);
    expect(assistantMsg.tool_calls).toBeUndefined();
    expect(assistantMsg.reasoning).toBe("truncated chain of thought");
    // The placeholder is a recognized sentinel, so it is stripped from
    // persisted/rendered history if a model echoes it back, and it carries no
    // control characters that a strict OpenAI-compatible backend might reject.
    expect(isPlaceholderSentinelText(EMPTY_ASSISTANT_TURN_PLACEHOLDER)).toBe(
      true,
    );
    expect(EMPTY_ASSISTANT_TURN_PLACEHOLDER).not.toContain("\x00");
  });

  test("leaves reasoning-only assistant content null when backfill is disabled", async () => {
    const { provider, requests } = stubProvider(
      [
        {
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        },
      ],
      { assistantReasoningField: "reasoning_content" },
    );

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "question" }] },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "truncated chain of thought",
            signature: "",
          },
        ],
      },
    ]);

    const params = requests[0] as {
      messages: Array<{ role: string; content: string | null }>;
    };
    const assistantMsg = params.messages.find((m) => m.role === "assistant")!;
    // Backfill defaults off, so providers that tolerate null assistant content
    // (e.g. OpenAI proper) are unaffected by the OpenRouter-specific guard.
    expect(assistantMsg.content).toBeNull();
  });

  test("does not backfill content when tool calls are present", async () => {
    const { provider, requests } = stubProvider([
      {
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      },
    ]);

    await provider.sendMessage([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "search", input: { q: "x" } },
        ],
      },
    ]);

    const params = requests[0] as {
      messages: Array<{ role: string; content: string | null }>;
    };
    // Tool-call-only assistant messages keep null content (preferred by
    // Anthropic-proxy/Bedrock backends); the placeholder is only for the
    // neither-content-nor-tool_calls case.
    expect(params.messages[0].content).toBeNull();
  });

  test("forwards config.top_p onto the request body", async () => {
    const { provider, requests } = stubProvider([
      {
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      },
    ]);

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { config: { top_p: 0.95 } },
    );

    const params = requests[0] as { top_p?: number };
    expect(params.top_p).toBe(0.95);
  });

  test("omits top_p from the request body when not configured", async () => {
    const { provider, requests } = stubProvider([
      {
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      },
    ]);

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);

    const params = requests[0] as { top_p?: number };
    expect(params.top_p).toBeUndefined();
  });

  test("skips Anthropic-originated thinking blocks (with signatures)", async () => {
    const { provider, requests } = stubProvider(
      [
        {
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        },
      ],
      { assistantReasoningField: "reasoning_content" },
    );

    await provider.sendMessage([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "anthropic thinking",
            signature: "sig-abc",
          },
          { type: "thinking", thinking: "deepseek thinking", signature: "" },
          { type: "text", text: "answer" },
        ],
      },
    ]);

    const params = requests[0] as {
      messages: Array<{
        role: string;
        reasoning_content?: string;
      }>;
    };
    expect(params.messages[0].reasoning_content).toBe("deepseek thinking");
  });
});

describe("reasoning opt-out rejection fallback", () => {
  function stubProviderWithErrors(
    errors: unknown[],
    chunks: MockChunk[],
  ): { provider: OpenAIChatCompletionsProvider; requests: unknown[] } {
    const provider = new OpenAIChatCompletionsProvider(
      "test-key",
      "test-model",
    );
    const requests: unknown[] = [];
    const pending = [...errors];
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            // Snapshot: the fallback mutates `params` between attempts.
            requests.push(JSON.parse(JSON.stringify(params)));
            const error = pending.shift();
            if (error !== undefined) {
              throw error;
            }
            return makeStream(chunks);
          },
        },
      },
    };
    return { provider, requests };
  }

  const okChunks: MockChunk[] = [
    {
      choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ];

  function rejection(message: string, status = 400): Error {
    return Object.assign(new Error(message), { status });
  }

  test("retries once without reasoning params when a model rejects the explicit opt-out", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [rejection("reasoning_effort 'none' is not supported for this model")],
      okChunks,
    );

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { config: { effort: "none" } },
    );

    expect(requests).toHaveLength(2);
    const first = requests[0] as { reasoning_effort?: string };
    const second = requests[1] as {
      reasoning_effort?: string;
      reasoning?: unknown;
    };
    expect(first.reasoning_effort).toBe("none");
    expect(second.reasoning_effort).toBeUndefined();
    expect(second.reasoning).toBeUndefined();
    const text = response.content.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(text?.text).toBe("ok");
  });

  test("does not retry when the request did not opt out of reasoning", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [rejection("reasoning_effort is invalid")],
      okChunks,
    );

    await expect(
      provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        { config: { effort: "high" } },
      ),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  test("does not retry a 4xx that does not name reasoning", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [rejection("invalid api key")],
      okChunks,
    );

    await expect(
      provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        { config: { effort: "none" } },
      ),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  test("does not retry server errors", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [rejection("reasoning backend unavailable", 500)],
      okChunks,
    );

    await expect(
      provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        { config: { effort: "none" } },
      ),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
});
