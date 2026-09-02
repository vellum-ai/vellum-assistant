import { describe, expect, test } from "bun:test";

import { ProviderError } from "../../../util/errors.js";
import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";

type MockChunk = {
  choices: Array<{
    delta: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
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

const OK_CHUNKS: MockChunk[] = [
  {
    choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  },
];

function stubProviderWithErrors(errors: unknown[]): {
  provider: OpenAIChatCompletionsProvider;
  requests: unknown[];
} {
  const provider = new OpenAIChatCompletionsProvider("test-key", "test-model");
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
          return makeStream(OK_CHUNKS);
        },
      },
    },
  };
  return { provider, requests };
}

// Together's server-side renderer error for MiniMax M3, verbatim.
const CHAT_TEMPLATE_400 =
  "Failed to apply chat template: invalid operation: object is not callable (in chat:22)";

function rejection(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status });
}

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("chat-template rejection flatten fallback", () => {
  test("retries once with flattened string content when the chat template rejects a text-only content-parts array", async () => {
    // GIVEN an endpoint whose chat template 400s on structured message content
    const { provider, requests } = stubProviderWithErrors([
      rejection(CHAT_TEMPLATE_400),
    ]);

    // WHEN a multi-block user message of purely textual parts is sent
    const response = await provider.sendMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "first paragraph" },
          { type: "text", text: "second paragraph" },
        ],
      },
    ]);

    // THEN the first request carried a content-parts array
    expect(requests).toHaveLength(2);
    const first = requests[0] as {
      messages: Array<{ content: unknown }>;
    };
    expect(Array.isArray(first.messages[0].content)).toBe(true);

    // AND the retry flattened it to a plain string keeping all the text
    const second = requests[1] as {
      messages: Array<{ content: unknown }>;
    };
    const flattened = second.messages[0].content;
    expect(flattened).toBe("first paragraph\n\nsecond paragraph");

    // AND the retry succeeded
    const text = response.content.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(text?.text).toBe("ok");
  });

  test("does not retry when a content-parts array carries media (never silently drop an image)", async () => {
    // GIVEN an endpoint whose chat template 400s on structured message content
    const { provider, requests } = stubProviderWithErrors([
      rejection(CHAT_TEMPLATE_400),
    ]);

    // WHEN a multi-block user message with an image part is sent
    const promise = provider.sendMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this image?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: TINY_PNG,
            },
          },
        ],
      },
    ]);

    // THEN the error propagates with no retry, so downstream classification
    // can surface the capability mismatch instead of answering without the image
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
    expect(requests).toHaveLength(1);
  });

  test("does not retry when the messages are already plain strings", async () => {
    // GIVEN a chat-template 400 on a request whose content is already a
    // plain string (flattening would change nothing, so retrying is futile)
    const { provider, requests } = stubProviderWithErrors([
      rejection(CHAT_TEMPLATE_400),
    ]);

    // WHEN a single-text-block user message is sent
    const promise = provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);

    // THEN the error propagates as a ProviderError with no retry attempt
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
    expect(requests).toHaveLength(1);
  });

  test("does not retry on 5xx even when the message mentions the chat template", async () => {
    // GIVEN a 500 whose body happens to mention the chat template (a server
    // fault, not a request-shape rejection)
    const { provider, requests } = stubProviderWithErrors([
      rejection(CHAT_TEMPLATE_400, 500),
    ]);

    // WHEN a multi-block user message is sent
    const promise = provider.sendMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]);

    // THEN the error propagates with no retry attempt
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
    expect(requests).toHaveLength(1);
  });

  test("surfaces the retry's error when the flattened request also fails", async () => {
    // GIVEN an endpoint that rejects both the structured and the flattened shape
    const { provider, requests } = stubProviderWithErrors([
      rejection(CHAT_TEMPLATE_400),
      rejection(CHAT_TEMPLATE_400),
    ]);

    // WHEN a multi-block user message is sent
    const promise = provider.sendMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]);

    // THEN the failure propagates after exactly one retry
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
    expect(requests).toHaveLength(2);
  });
});
