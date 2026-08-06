/**
 * Routing of OpenRouter `openai/*` models with explicit prompt caching onto
 * the Responses transport: flagged models hit `/responses` with cache params,
 * attribution headers, and `provider.only` pass-through; unflagged and
 * native-web-search traffic stays on chat completions.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock openai module — must be before importing the provider. Captures both
// the chat-completions and Responses surfaces so routing is observable.
// ---------------------------------------------------------------------------

let chatCalls: Array<Record<string, unknown>> = [];
let responsesCalls: Array<Record<string, unknown>> = [];
let lastResponsesOptions: Record<string, unknown> | null = null;
let lastConstructorOptions: Record<string, unknown> | null = null;

mock.module("openai", () => ({
  default: class MockOpenAI {
    constructor(opts: Record<string, unknown>) {
      lastConstructorOptions = opts;
    }
    chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          chatCalls.push(params);
          return {
            [Symbol.asyncIterator]: async function* () {
              yield {
                choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
                model: String(params.model),
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              };
            },
          };
        },
      },
    };
    responses = {
      create: async (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => {
        responsesCalls.push(params);
        lastResponsesOptions = options ?? null;
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: "response.output_text.delta", delta: "ok" };
            yield {
              type: "response.completed",
              response: {
                model: String(params.model),
                status: "completed",
                output: [],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
          },
        };
      },
    };
  },
}));

// Import after mocking
import { OpenRouterProvider } from "../providers/openrouter/client.js";
import type { Message } from "../providers/types.js";

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

beforeEach(() => {
  chatCalls = [];
  responsesCalls = [];
  lastResponsesOptions = null;
  lastConstructorOptions = null;
});

describe("OpenRouter Responses transport routing", () => {
  test("flagged openai/* model routes to /responses with cache params", async () => {
    const provider = new OpenRouterProvider("sk-or-test", "openai/gpt-5.6-sol");
    await provider.sendMessage([userMsg("hi")], {
      config: { promptCacheKey: "conv-1" },
    });

    expect(chatCalls).toHaveLength(0);
    expect(responsesCalls).toHaveLength(1);
    const params = responsesCalls[0];
    expect(params.model).toBe("openai/gpt-5.6-sol");
    expect(params.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(params.prompt_cache_key).toBe("conv-1");
    expect(JSON.stringify(params.input)).toContain("prompt_cache_breakpoint");
    // The delegate targets OpenRouter, not api.openai.com.
    expect(lastConstructorOptions?.baseURL).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  test("sends OpenRouter app-attribution headers on /responses requests", async () => {
    const provider = new OpenRouterProvider(
      "sk-or-test",
      "openai/gpt-5.6-luna",
    );
    await provider.sendMessage([userMsg("hi")]);

    expect(responsesCalls).toHaveLength(1);
    expect(lastResponsesOptions?.headers).toEqual(
      expect.objectContaining({
        "HTTP-Referer": "https://www.vellum.ai",
        "X-OpenRouter-Title": "Vellum Assistant",
      }),
    );
  });

  test("openrouter.only becomes provider.only on the /responses body", async () => {
    const provider = new OpenRouterProvider(
      "sk-or-test",
      "openai/gpt-5.6-terra",
    );
    await provider.sendMessage([userMsg("hi")], {
      config: { openrouter: { only: ["OpenAI"] } },
    });

    expect(responsesCalls).toHaveLength(1);
    expect(responsesCalls[0].provider).toEqual({ only: ["OpenAI"] });
  });

  test("model override onto a flagged model routes to /responses", async () => {
    const provider = new OpenRouterProvider("sk-or-test", "x-ai/grok-4.20");
    await provider.sendMessage([userMsg("hi")], {
      config: { model: "openai/gpt-5.6-luna" },
    });

    expect(chatCalls).toHaveLength(0);
    expect(responsesCalls).toHaveLength(1);
    expect(responsesCalls[0].model).toBe("openai/gpt-5.6-luna");
  });

  test("unflagged models stay on chat completions", async () => {
    const provider = new OpenRouterProvider("sk-or-test", "x-ai/grok-4.20");
    await provider.sendMessage([userMsg("hi")]);

    expect(responsesCalls).toHaveLength(0);
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0].model).toBe("x-ai/grok-4.20");
  });

  test("unflagged openai/* models stay on chat completions", async () => {
    const provider = new OpenRouterProvider("sk-or-test", "openai/gpt-5.5");
    await provider.sendMessage([userMsg("hi")]);

    expect(responsesCalls).toHaveLength(0);
    expect(chatCalls).toHaveLength(1);
  });

  test("native web search keeps flagged models on chat completions", async () => {
    const provider = new OpenRouterProvider(
      "sk-or-test",
      "openai/gpt-5.6-sol",
      { useNativeWebSearch: true },
    );
    await provider.sendMessage([userMsg("hi")]);

    expect(responsesCalls).toHaveLength(0);
    expect(chatCalls).toHaveLength(1);
  });
});
