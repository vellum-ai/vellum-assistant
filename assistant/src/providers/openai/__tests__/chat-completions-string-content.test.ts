import { describe, expect, test } from "bun:test";

import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";
import { rejection, stubClient } from "./chat-completions-stub.js";

function stubProviderWithErrors(errors: unknown[]): {
  provider: OpenAIChatCompletionsProvider;
  requests: unknown[];
} {
  const provider = new OpenAIChatCompletionsProvider("test-key", "test-model");
  const requests = stubClient(
    provider,
    [
      {
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ],
    errors,
  );
  return { provider, requests };
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

  test("does not retry a tool-schema error about a param named content", async () => {
    // Not a message-content rejection: flattening would silently drop
    // attachments without fixing anything.
    const { provider, requests } = stubProviderWithErrors([
      rejection(
        "tools.0.function.parameters.properties.content: Input should be a valid string",
      ),
    ]);

    await expect(provider.sendMessage(multiPartMessages)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  test("removes two independent incompatibilities in one call", async () => {
    const { provider, requests } = stubProviderWithErrors([
      rejection("reasoning_effort 'none' is not supported for this model"),
      rejection("body/messages/0/content must be string"),
    ]);

    const response = await provider.sendMessage(multiPartMessages, {
      config: { effort: "none" },
    });

    expect(requests).toHaveLength(3);
    const last = requests[2] as {
      reasoning_effort?: string;
      messages: Array<{ content: unknown }>;
    };
    expect(last.reasoning_effort).toBeUndefined();
    expect(typeof last.messages[0].content).toBe("string");
    const text = response.content.find((b) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    expect(text?.text).toBe("ok");
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
      rejection("body/messages/1/content must be string", 500),
    ]);

    await expect(provider.sendMessage(multiPartMessages)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
});
