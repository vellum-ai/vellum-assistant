import { describe, expect, test } from "bun:test";

import OpenAI from "openai";

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
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
  };
};

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

  test("round-trips reasoning_content on assistant messages that carry tool_calls", async () => {
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
            thinking: "need the search tool",
            signature: "",
          },
          { type: "tool_use", id: "call_1", name: "search", input: { q: "x" } },
        ],
      },
    ]);

    const params = requests[0] as {
      messages: Array<{
        role: string;
        content: string | null;
        reasoning_content?: string;
        tool_calls?: unknown;
      }>;
    };
    expect(params.messages[0]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "need the search tool",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "search", arguments: JSON.stringify({ q: "x" }) },
        },
      ],
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

  test("backfills placeholder content for a reasoning-only assistant turn", async () => {
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

  test("backfills placeholder for a whitespace-only assistant turn", async () => {
    const { provider, requests } = stubProvider([
      {
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      },
    ]);

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "assistant", content: [{ type: "text", text: "  \n" }] },
    ]);

    const params = requests[0] as {
      messages: Array<{ role: string; content: string | null }>;
    };
    const assistantMsg = params.messages.find((m) => m.role === "assistant")!;
    // Validators that trim before checking presence treat whitespace-only
    // content as absent, so it needs the same placeholder as empty content.
    expect(assistantMsg.content).toBe(EMPTY_ASSISTANT_TURN_PLACEHOLDER);
  });

  test("backfills placeholder when thinking is dropped and no text was emitted", async () => {
    // Custom openai-compatible endpoints do not set assistantReasoningField, so
    // a Stop during thinking serializes to blank content with no tool calls
    // unless the backfill guard runs.
    const { provider, requests } = stubProvider([
      {
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      },
    ]);

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "question" }] },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "aborted mid-thought",
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
        reasoning_content?: string;
        tool_calls?: unknown;
      }>;
    };
    const assistantMsg = params.messages.find((m) => m.role === "assistant")!;
    expect(assistantMsg.content).toBe(EMPTY_ASSISTANT_TURN_PLACEHOLDER);
    expect(assistantMsg.tool_calls).toBeUndefined();
    expect(assistantMsg.reasoning).toBeUndefined();
    expect(assistantMsg.reasoning_content).toBeUndefined();
  });

  test("backfills placeholder for an empty aborted assistant turn", async () => {
    const { provider, requests } = stubProvider([
      {
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      },
    ]);

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "assistant", content: [] },
    ]);

    const params = requests[0] as {
      messages: Array<{ role: string; content: string | null }>;
    };
    const assistantMsg = params.messages.find((m) => m.role === "assistant")!;
    expect(assistantMsg.content).toBe(EMPTY_ASSISTANT_TURN_PLACEHOLDER);
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
      messages: Array<{
        role: string;
        content: string | null;
        reasoning_content?: string;
      }>;
    };
    // Tool-call-only assistant messages keep null content (preferred by
    // Anthropic-proxy/Bedrock backends); the placeholder is only for the
    // neither-content-nor-tool_calls case. The reasoning field stays omitted
    // when assistantReasoningField is unset.
    expect(params.messages[0].content).toBeNull();
    expect(params.messages[0].reasoning_content).toBeUndefined();
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

  test("omits empty reasoning_content on tool-call turns even when the field is set", async () => {
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
          { type: "tool_use", id: "call_1", name: "search", input: { q: "x" } },
        ],
      },
    ]);

    const params = requests[0] as {
      messages: Array<{
        role: string;
        content: string | null;
        tool_calls?: unknown;
        reasoning_content?: string;
      }>;
    };
    const assistantMsg = params.messages[0];
    expect(assistantMsg.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "search", arguments: JSON.stringify({ q: "x" }) },
      },
    ]);
    expect(assistantMsg.reasoning_content).toBeUndefined();
  });

  test("omits empty reasoning on tool-call turns for the OpenRouter-style field", async () => {
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
          { type: "tool_use", id: "call_1", name: "search", input: { q: "x" } },
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
    expect(params.messages[0].reasoning).toBeUndefined();
    expect(params.messages[0].reasoning_content).toBeUndefined();
  });

  test("omits empty reasoning_content on text-only turns even when the field is set", async () => {
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
        content: [{ type: "text", text: "plain reply" }],
      },
    ]);

    const params = requests[0] as {
      messages: Array<{
        role: string;
        content: string | null;
        reasoning_content?: string;
      }>;
    };
    expect(params.messages[0].content).toBe("plain reply");
    expect(params.messages[0].reasoning_content).toBeUndefined();
  });
});

function stubProviderWithErrors(
  errors: unknown[],
  chunks: MockChunk[],
  options?: OpenAIChatCompletionsProviderOptions,
): { provider: OpenAIChatCompletionsProvider; requests: unknown[] } {
  const provider = new OpenAIChatCompletionsProvider(
    "test-key",
    "test-model",
    options,
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

const OK_CHUNKS: MockChunk[] = [
  {
    choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  },
];

function rejection(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status });
}

describe("reasoning opt-out rejection fallback", () => {
  test("retries once without reasoning params when a model rejects the explicit opt-out", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [rejection("reasoning_effort 'none' is not supported for this model")],
      OK_CHUNKS,
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

  test("retries once for an OpenRouter-wrapped reasoning rejection (detail in metadata.raw)", async () => {
    // OpenRouter's SDK APIError.message is the generic wrapper
    // ("400 Provider returned error"); the real reason lives only in
    // error.error.metadata.raw, which normalizeOpenAIAPIError promotes into the
    // normalized message. Matching error.message alone would miss it and the
    // opt-out rejection would hard-fail instead of retrying.
    const wrapped = new OpenAI.APIError(
      400,
      {
        code: 400,
        message: "Provider returned error",
        metadata: {
          raw: "reasoning_effort 'none' is not supported for this reasoning model",
          provider_name: "deepseek",
        },
      },
      undefined,
      new Headers(),
    );
    // Guard: the wrapper message carries no reasoning signal, so the fallback
    // can only fire off the normalized upstream detail.
    expect(/reasoning/i.test(wrapped.message)).toBe(false);

    const { provider, requests } = stubProviderWithErrors([wrapped], OK_CHUNKS);

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
      OK_CHUNKS,
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
      OK_CHUNKS,
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
      OK_CHUNKS,
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

describe("thinking-mode tool_choice rejection fallback", () => {
  test("retries once without tool_choice when thinking mode rejects it", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [rejection("Thinking mode does not support this tool_choice")],
      OK_CHUNKS,
    );

    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      {
        tools: [
          {
            name: "bash",
            description: "Run a shell command",
            input_schema: { type: "object", properties: {} },
          },
        ],
        config: { tool_choice: { type: "none" }, effort: "high" },
      },
    );

    expect(requests).toHaveLength(2);
    const first = requests[0] as {
      tool_choice?: string;
      reasoning_effort?: string;
    };
    const second = requests[1] as {
      tool_choice?: string;
      reasoning_effort?: string;
    };
    expect(first.tool_choice).toBe("none");
    expect(first.reasoning_effort).toBe("high");
    expect(second.tool_choice).toBeUndefined();
    expect(second.reasoning_effort).toBe("high");
    const text = response.content.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(text?.text).toBe("ok");
  });

  test("retries once for an OpenRouter-wrapped thinking-mode tool_choice rejection", async () => {
    const wrapped = new OpenAI.APIError(
      400,
      {
        code: 400,
        message: "Provider returned error",
        metadata: {
          raw: "[invalid_request_error] Thinking mode does not support this tool_choice",
          provider_name: "deepseek",
        },
      },
      undefined,
      new Headers(),
    );
    expect(/tool_choice/i.test(wrapped.message)).toBe(false);

    const { provider, requests } = stubProviderWithErrors([wrapped], OK_CHUNKS);

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      {
        tools: [
          {
            name: "bash",
            description: "Run a shell command",
            input_schema: { type: "object", properties: {} },
          },
        ],
        config: { tool_choice: { type: "none" }, effort: "high" },
      },
    );

    expect(requests).toHaveLength(2);
    expect((requests[0] as { tool_choice?: string }).tool_choice).toBe("none");
    expect(
      (requests[1] as { tool_choice?: string }).tool_choice,
    ).toBeUndefined();
  });

  test("does not retry a 4xx that does not name tool_choice", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [rejection("invalid api key")],
      OK_CHUNKS,
    );

    await expect(
      provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        {
          tools: [
            {
              name: "bash",
              description: "Run a shell command",
              input_schema: { type: "object", properties: {} },
            },
          ],
          config: { tool_choice: { type: "none" }, effort: "high" },
        },
      ),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  test("does not retry thinking-mode tool_choice 500s", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [rejection("Thinking mode does not support this tool_choice", 500)],
      OK_CHUNKS,
    );

    await expect(
      provider.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        {
          tools: [
            {
              name: "bash",
              description: "Run a shell command",
              input_schema: { type: "object", properties: {} },
            },
          ],
          config: { tool_choice: { type: "none" }, effort: "high" },
        },
      ),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
});

describe("missing reasoning_content rejection fallback", () => {
  const toolCallHistory = [
    {
      role: "assistant" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "call_1",
          name: "search",
          input: { q: "x" },
        },
      ],
    },
  ];

  test("retries once with empty reasoning_content when thinking mode requires it", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [
        rejection(
          "The reasoning_content in the thinking mode must be passed back to the API",
        ),
      ],
      OK_CHUNKS,
      { assistantReasoningField: "reasoning_content" },
    );

    const response = await provider.sendMessage(toolCallHistory);

    expect(requests).toHaveLength(2);
    const first = requests[0] as {
      messages: Array<{ reasoning_content?: string }>;
    };
    const second = requests[1] as {
      messages: Array<{ reasoning_content?: string }>;
    };
    expect(first.messages[0].reasoning_content).toBeUndefined();
    expect(second.messages[0].reasoning_content).toBe("");
    const text = response.content.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(text?.text).toBe("ok");
  });

  test("retries once for an OpenRouter-wrapped missing reasoning_content rejection", async () => {
    const wrapped = new OpenAI.APIError(
      400,
      {
        code: 400,
        message: "Provider returned error",
        metadata: {
          raw: "[invalid_request_error] The reasoning_content in the thinking mode must be passed back to the API",
          provider_name: "deepseek",
        },
      },
      undefined,
      new Headers(),
    );
    expect(/reasoning_content/i.test(wrapped.message)).toBe(false);

    const { provider, requests } = stubProviderWithErrors(
      [wrapped],
      OK_CHUNKS,
      {
        assistantReasoningField: "reasoning_content",
      },
    );

    await provider.sendMessage(toolCallHistory);

    expect(requests).toHaveLength(2);
    expect(
      (requests[0] as { messages: Array<{ reasoning_content?: string }> })
        .messages[0].reasoning_content,
    ).toBeUndefined();
    expect(
      (requests[1] as { messages: Array<{ reasoning_content?: string }> })
        .messages[0].reasoning_content,
    ).toBe("");
  });

  test("does not retry a 4xx that does not require reasoning_content round-trip", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [rejection("invalid api key")],
      OK_CHUNKS,
      { assistantReasoningField: "reasoning_content" },
    );

    await expect(provider.sendMessage(toolCallHistory)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  test("does not retry missing reasoning_content 500s", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [
        rejection(
          "The reasoning_content in the thinking mode must be passed back to the API",
          500,
        ),
      ],
      OK_CHUNKS,
      { assistantReasoningField: "reasoning_content" },
    );

    await expect(provider.sendMessage(toolCallHistory)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
});

describe("unknown assistant reasoning field rejection fallback", () => {
  const thinkingHistory = [
    {
      role: "assistant" as const,
      content: [
        { type: "thinking" as const, thinking: "hidden chain", signature: "" },
        { type: "text" as const, text: "answer" },
      ],
    },
  ];

  test("retries once without reasoning_content when a strict schema rejects it", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [
        rejection(
          "Additional properties are not allowed ('reasoning_content' was unexpected)",
        ),
      ],
      OK_CHUNKS,
      { assistantReasoningField: "reasoning_content" },
    );

    const response = await provider.sendMessage(thinkingHistory);

    expect(requests).toHaveLength(2);
    const first = requests[0] as {
      messages: Array<{ reasoning_content?: string; content: string | null }>;
    };
    const second = requests[1] as {
      messages: Array<{ reasoning_content?: string; content: string | null }>;
    };
    expect(first.messages[0].reasoning_content).toBe("hidden chain");
    expect(second.messages[0].reasoning_content).toBeUndefined();
    expect(second.messages[0].content).toBe("answer");
    const text = response.content.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(text?.text).toBe("ok");
  });

  test("does not strip reasoning_content on a must-be-passed-back error", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [
        rejection(
          "The reasoning_content in the thinking mode must be passed back to the API",
        ),
      ],
      OK_CHUNKS,
      { assistantReasoningField: "reasoning_content" },
    );

    await expect(provider.sendMessage(thinkingHistory)).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(
      (requests[0] as { messages: Array<{ reasoning_content?: string }> })
        .messages[0].reasoning_content,
    ).toBe("hidden chain");
  });

  test("does not retry unknown-field 500s", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [
        rejection(
          "Additional properties are not allowed ('reasoning_content' was unexpected)",
          500,
        ),
      ],
      OK_CHUNKS,
      { assistantReasoningField: "reasoning_content" },
    );

    await expect(provider.sendMessage(thinkingHistory)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
});

describe("OpenAIChatCompletionsProvider cache usage parsing", () => {
  test("maps prompt_tokens_details cache fields into usage", async () => {
    // prompt_tokens is the inclusive total; the cached subset surfaces as
    // cacheReadInputTokens and the written subset (GPT-5.6+
    // cache_write_tokens, billed at 1.25x input) as cacheCreationInputTokens.
    const { provider } = stubProvider([
      { choices: [{ delta: { content: "ok" } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 2_006,
          completion_tokens: 300,
          prompt_tokens_details: {
            cached_tokens: 1_920,
            cache_write_tokens: 64,
          },
        },
      },
    ]);

    const response = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);

    expect(response.usage).toEqual({
      inputTokens: 2_006,
      outputTokens: 300,
      cacheReadInputTokens: 1_920,
      cacheCreationInputTokens: 64,
    });
  });

  test("omits cache fields when prompt_tokens_details is absent", async () => {
    const { provider } = stubProvider([
      { choices: [{ delta: { content: "ok" } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
    ]);

    const response = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);

    expect(response.usage).not.toHaveProperty("cacheReadInputTokens");
    expect(response.usage).not.toHaveProperty("cacheCreationInputTokens");
  });
});

describe("OpenAIChatCompletionsProvider response model", () => {
  test("reports the model echoed back by the provider chunks", async () => {
    const { provider } = stubProvider([
      { choices: [{ delta: { content: "ok" } }], model: "server-model-xyz" },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
        model: "server-model-xyz",
      },
    ]);

    const response = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);

    expect(response.model).toBe("server-model-xyz");
  });

  test("falls back to the configured model when chunks omit `model`", async () => {
    // opencode/OpenRouter can stream a usage report with no `model` field.
    // The response must carry the configured model rather than an undefined
    // that crashes the downstream calibrator and violates the usage-event
    // NOT NULL constraint on `model`.
    const { provider } = stubProvider([
      { choices: [{ delta: { content: "ok" } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      },
    ]);

    const response = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);

    expect(response.model).toBe("test-model");
  });
});
