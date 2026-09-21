import { describe, expect, test } from "bun:test";

import { ProviderError } from "../../../util/errors.js";
import { MALFORMED_TOOL_CALL_MESSAGE } from "../../malformed-tool-call.js";
import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";

type MockChunk = {
  choices: Array<{
    delta: { content?: string | null };
    finish_reason?: string | null;
    native_finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

const MESSAGES = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "upload the cover image" }],
  },
];

function stubProvider(chunks: MockChunk[]): OpenAIChatCompletionsProvider {
  const provider = new OpenAIChatCompletionsProvider(
    "test-key",
    "google/gemini-3.8-flash",
  );
  (provider as unknown as { client: unknown }).client = {
    baseURL: "https://openrouter.example.com/api/v1",
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            for (const c of chunks) {
              yield c;
            }
          },
        }),
      },
    },
  };
  return provider;
}

function finishChunks(
  text: string,
  finishReason: string,
  nativeFinishReason: string,
): MockChunk[] {
  return [
    { choices: [{ delta: { content: text } }] },
    {
      choices: [
        {
          delta: {},
          finish_reason: finishReason,
          native_finish_reason: nativeFinishReason,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    },
  ];
}

describe("OpenAIChatCompletionsProvider malformed tool-call finish", () => {
  test("throws a status-less malformed tool-call error on native MALFORMED_FUNCTION_CALL", async () => {
    const provider = stubProvider(
      finishChunks(
        ",featuredImage:{_type:image},patch:true}]})",
        "stop",
        "MALFORMED_FUNCTION_CALL",
      ),
    );

    const error = await provider.sendMessage(MESSAGES).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.statusCode).toBeUndefined();
    expect(providerError.message).toContain(MALFORMED_TOOL_CALL_MESSAGE);
    expect(providerError.message).toContain("MALFORMED_FUNCTION_CALL");
  });

  test("throws on native UNEXPECTED_TOOL_CALL", async () => {
    const provider = stubProvider(
      finishChunks("{}", "error", "UNEXPECTED_TOOL_CALL"),
    );

    await expect(provider.sendMessage(MESSAGES)).rejects.toThrow(
      MALFORMED_TOOL_CALL_MESSAGE,
    );
  });

  test("returns the response normally on native STOP", async () => {
    const provider = stubProvider(finishChunks("All done.", "stop", "STOP"));

    const response = await provider.sendMessage(MESSAGES);

    expect(response.stopReason).toBe("stop");
    expect(response.content).toEqual([{ type: "text", text: "All done." }]);
  });
});
