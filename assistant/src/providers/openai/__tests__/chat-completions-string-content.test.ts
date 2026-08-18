import { describe, expect, test } from "bun:test";

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
          return makeStream([
            {
              choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
          ]);
        },
      },
    },
  };
  return { provider, requests };
}

function rejection(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status });
}

// A user message with text + image serializes to a content-parts array.
const multiPartMessages = [
  {
    role: "user" as const,
    content: [
      { type: "text" as const, text: "what is this?" },
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: "image/png",
          data: "aGk=",
        },
      },
    ],
  },
];

describe("string-only content rejection fallback", () => {
  test("retries once with content flattened to strings", async () => {
    const { provider, requests } = stubProviderWithErrors([
      rejection("body/messages/1/content must be string"),
    ]);

    const response = await provider.sendMessage(multiPartMessages);

    expect(requests).toHaveLength(2);
    const first = requests[0] as {
      messages: Array<{ content: unknown }>;
    };
    const second = requests[1] as {
      messages: Array<{ content: unknown }>;
    };
    expect(Array.isArray(first.messages[0].content)).toBe(true);
    const flattened = second.messages[0].content;
    expect(typeof flattened).toBe("string");
    expect(flattened).toContain("what is this?");
    expect(flattened).toContain("[image_url omitted");
    const text = response.content.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(text?.text).toBe("ok");
  });

  test("retries for a pydantic-style rejection (vLLM shape)", async () => {
    const { provider, requests } = stubProviderWithErrors([
      rejection("messages.0.content: Input should be a valid string"),
    ]);

    await provider.sendMessage(multiPartMessages);

    expect(requests).toHaveLength(2);
  });

  test("does not retry when no message carried array content", async () => {
    // A single text block serializes to a plain string already, so a retry
    // would resend an identical request.
    const { provider, requests } = stubProviderWithErrors([
      rejection("body/messages/1/content must be string"),
    ]);

    await expect(
      provider.sendMessage([
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ]),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  test("does not retry an unrelated 400", async () => {
    const { provider, requests } = stubProviderWithErrors([
      rejection("invalid api key"),
    ]);

    await expect(provider.sendMessage(multiPartMessages)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  test("does not retry server errors", async () => {
    const { provider, requests } = stubProviderWithErrors([
      rejection("content must be string", 500),
    ]);

    await expect(provider.sendMessage(multiPartMessages)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
});
