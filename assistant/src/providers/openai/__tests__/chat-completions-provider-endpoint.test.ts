/**
 * Verifies that `OpenAIChatCompletionsProvider` reports the endpoint its live
 * SDK client actually resolved to via `ProviderResponse.resolvedEndpoint`.
 *
 * This is the runtime-observed routing signal consumed by diagnostics: it must
 * come from the client instance that issued the request, never from a config
 * re-read, so a misrouted host is observed rather than inferred.
 */

import { describe, expect, test } from "bun:test";

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
      for (const c of chunks) yield c;
    },
  };
}

/**
 * Access the private SDK client without replacing it, so `client.baseURL`
 * remains the value the real OpenAI SDK computed from the constructor options.
 * Only `create` is swapped for a canned stream.
 */
function stubCreate(
  provider: OpenAIChatCompletionsProvider,
  chunks: MockChunk[],
): { observedBaseUrl: string } {
  const inner = provider as unknown as {
    client: {
      baseURL: string;
      chat: {
        completions: {
          create: (params: unknown) => Promise<AsyncIterable<MockChunk>>;
        };
      };
    };
  };
  const observedBaseUrl = inner.client.baseURL;
  inner.client.chat.completions.create = async () => makeStream(chunks);
  return { observedBaseUrl };
}

describe("OpenAIChatCompletionsProvider resolvedEndpoint", () => {
  test("reports the base URL observed from the live SDK client", async () => {
    // GIVEN a provider configured with an explicit base URL (as managed
    // inference / Baseten would supply)
    const provider = new OpenAIChatCompletionsProvider(
      "test-key",
      "test-model",
      {
        baseURL: "https://inference.example.test/v1",
      },
    );

    // AND a stubbed completion stream that leaves the real client instance intact
    const { observedBaseUrl } = stubCreate(provider, OK_CHUNKS);

    // WHEN a message is sent through the provider
    const response = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);

    // THEN the response carries the endpoint read off the live client, not a
    // hardcoded or config-derived value
    expect(response.resolvedEndpoint).toBe(observedBaseUrl);

    // AND that endpoint reflects the configured host
    expect(response.resolvedEndpoint).toContain("inference.example.test");
  });
});
