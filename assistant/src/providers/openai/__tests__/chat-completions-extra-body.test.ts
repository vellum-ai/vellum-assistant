import { describe, expect, test } from "bun:test";

import OpenAI from "openai";

import { ProviderError } from "../../../util/errors.js";
import { ContextOverflowError, type SendMessageOptions } from "../../types.js";
import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";

class ExtraBodyProvider extends OpenAIChatCompletionsProvider {
  protected override buildRequestExtraBody(
    _options?: SendMessageOptions,
  ): Record<string, unknown> | undefined {
    return { directions: { companion: 0.4 } };
  }
}

describe("chat-completions extraBody", () => {
  test("merges subclass extra body fields onto the SDK create params", async () => {
    const provider = new ExtraBodyProvider("test-key", "qwen/qwen3-8b");
    let seenParams: Record<string, unknown> | undefined;
    let seenOptions: Record<string, unknown> | undefined;
    (
      provider as unknown as {
        client: {
          chat: {
            completions: {
              create: (
                params: Record<string, unknown>,
                options?: Record<string, unknown>,
              ) => Promise<AsyncIterable<unknown>>;
            };
          };
        };
      }
    ).client.chat.completions.create = async (params, options) => {
      seenParams = params;
      seenOptions = options;
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      };
    };

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(seenParams?.directions).toEqual({ companion: 0.4 });
    expect(seenOptions?.extraBody).toBeUndefined();
  });

  test("attaches the SDK create params as ProviderError.rawRequest on 4xx", async () => {
    const provider = new ExtraBodyProvider("test-key", "qwen/qwen3-8b", {
      providerName: "vellum",
      providerLabel: "Vellum",
    });
    (
      provider as unknown as {
        client: {
          chat: {
            completions: {
              create: () => Promise<AsyncIterable<unknown>>;
            };
          };
        };
      }
    ).client.chat.completions.create = async () => {
      throw new OpenAI.APIError(
        400,
        { detail: "directions are not loaded" },
        undefined,
        new Headers(),
      );
    };

    try {
      await provider.sendMessage([
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ]);
      throw new Error("expected ProviderError");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const rejected = error as ProviderError;
      expect(rejected.provider).toBe("vellum");
      expect(rejected.statusCode).toBe(400);
      expect(rejected.rawRequest).toEqual(
        expect.objectContaining({
          model: "qwen/qwen3-8b",
          directions: { companion: 0.4 },
        }),
      );
    }
  });

  test("attaches the SDK create params as ContextOverflowError.rawRequest", async () => {
    const provider = new ExtraBodyProvider("test-key", "qwen/qwen3-8b", {
      providerName: "vellum",
      providerLabel: "Vellum",
    });
    (
      provider as unknown as {
        client: {
          chat: {
            completions: {
              create: () => Promise<AsyncIterable<unknown>>;
            };
          };
        };
      }
    ).client.chat.completions.create = async () => {
      throw new OpenAI.APIError(
        400,
        {
          message:
            "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
        undefined,
        new Headers(),
      );
    };

    try {
      await provider.sendMessage([
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ]);
      throw new Error("expected ContextOverflowError");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextOverflowError);
      const rejected = error as ContextOverflowError;
      expect(rejected.provider).toBe("vellum");
      expect(rejected.rawRequest).toEqual(
        expect.objectContaining({
          model: "qwen/qwen3-8b",
          directions: { companion: 0.4 },
        }),
      );
    }
  });
});
