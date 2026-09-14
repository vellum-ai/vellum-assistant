/**
 * Request-shape coverage for the output-token-limit wire key.
 *
 * The shared OpenAI-compatible transport defaults to `max_completion_tokens`.
 * OpenRouter's parameter router matches `max_tokens` on `require_parameters`
 * routes, except GPT-5.1/5.2 Codex and Chat which advertise only
 * `max_completion_tokens`.
 */

import { describe, expect, test } from "bun:test";

import {
  openRouterOutputTokenLimitField,
  OpenRouterProvider,
} from "../../openrouter/client.js";
import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";

type MockChunk = {
  choices: Array<{
    delta: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

const OK_CHUNKS: MockChunk[] = [
  {
    choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  },
];

function makeStream(chunks: MockChunk[]): AsyncIterable<MockChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        yield c;
      }
    },
  };
}

function stubCreate(provider: OpenAIChatCompletionsProvider): {
  requests: Record<string, unknown>[];
} {
  const requests: Record<string, unknown>[] = [];
  const inner = provider as unknown as {
    client: {
      chat: {
        completions: {
          create: (
            params: Record<string, unknown>,
          ) => Promise<AsyncIterable<MockChunk>>;
        };
      };
    };
  };
  inner.client.chat.completions.create = async (params) => {
    requests.push(params);
    return makeStream(OK_CHUNKS);
  };
  return { requests };
}

describe("chat-completions output-token-limit wire key", () => {
  test("default OpenAI path sends max_completion_tokens and omits max_tokens", async () => {
    const provider = new OpenAIChatCompletionsProvider(
      "test-key",
      "test-model",
    );
    const { requests } = stubCreate(provider);

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { config: { max_tokens: 64000 } },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].max_completion_tokens).toBe(64000);
    expect(requests[0]).not.toHaveProperty("max_tokens");
  });

  test("OpenRouter chat-completions path sends max_tokens and omits max_completion_tokens", async () => {
    const provider = new OpenRouterProvider("or-key", "@preset/example");
    const { requests } = stubCreate(provider);

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { config: { max_tokens: 64000 } },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].max_tokens).toBe(64000);
    expect(requests[0]).not.toHaveProperty("max_completion_tokens");
  });

  test("OpenRouter GPT-5.2 Codex sends max_completion_tokens and omits max_tokens", async () => {
    const provider = new OpenRouterProvider("or-key", "openai/gpt-5.2-codex");
    const { requests } = stubCreate(provider);

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { config: { max_tokens: 64000 } },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].max_completion_tokens).toBe(64000);
    expect(requests[0]).not.toHaveProperty("max_tokens");
  });

  test("OpenRouter per-call model override uses the overridden model's wire key", async () => {
    const provider = new OpenRouterProvider("or-key", "x-ai/grok-4.20");
    const { requests } = stubCreate(provider);

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { config: { model: "openai/gpt-5.1-codex-mini", max_tokens: 64000 } },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].max_completion_tokens).toBe(64000);
    expect(requests[0]).not.toHaveProperty("max_tokens");
  });
});

describe("openRouterOutputTokenLimitField", () => {
  test.each([
    ["@preset/example", "max_tokens"],
    ["x-ai/grok-4.20", "max_tokens"],
    ["openai/gpt-5.2", "max_tokens"],
    ["openai/gpt-5.2-pro", "max_tokens"],
    ["openai/gpt-5.3-codex", "max_tokens"],
    ["openai/gpt-5.2-codex", "max_completion_tokens"],
    ["openai/gpt-5.2-chat", "max_completion_tokens"],
    ["openai/gpt-5.1-codex", "max_completion_tokens"],
    ["openai/gpt-5.1-codex-max", "max_completion_tokens"],
    ["openai/gpt-5.1-codex-mini", "max_completion_tokens"],
  ] as const)("%s -> %s", (model, field) => {
    expect(openRouterOutputTokenLimitField(model)).toBe(field);
  });
});
