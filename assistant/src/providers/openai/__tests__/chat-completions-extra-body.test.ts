import { describe, expect, test } from "bun:test";

import type { SendMessageOptions } from "../../types.js";
import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";

class ExtraBodyProvider extends OpenAIChatCompletionsProvider {
  protected override buildRequestExtraBody(
    _options?: SendMessageOptions,
  ): Record<string, unknown> | undefined {
    return { directions: { companion: 0.4 } };
  }
}

describe("chat-completions extraBody", () => {
  test("forwards subclass extraBody on the SDK request options", async () => {
    const provider = new ExtraBodyProvider("test-key", "qwen/qwen3-8b");
    let seen: Record<string, unknown> | undefined;
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
    ).client.chat.completions.create = async (_params, options) => {
      seen = options;
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
    expect(seen?.extraBody).toEqual({ directions: { companion: 0.4 } });
  });
});
