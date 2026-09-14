import { describe, expect, test } from "bun:test";

import OpenAI from "openai";

import { GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE } from "../../gemini-thought-signature.js";
import {
  OpenAIChatCompletionsProvider,
  type OpenAIChatCompletionsProviderOptions,
} from "../chat-completions-provider.js";

type MockToolCallDelta = {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
  extra_content?: {
    google?: { thought_signature?: string; thoughtSignature?: string };
  };
};

type MockChunk = {
  choices: Array<{
    delta: {
      content?: string | null;
      tool_calls?: MockToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  model?: string;
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

function stubProvider(
  chunks: MockChunk[],
  options?: OpenAIChatCompletionsProviderOptions & { model?: string },
): {
  provider: OpenAIChatCompletionsProvider;
  requests: unknown[];
} {
  const provider = new OpenAIChatCompletionsProvider(
    "test-key",
    options?.model ?? "test-model",
    options,
  );
  const requests: unknown[] = [];
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
  return { provider, requests };
}

function stubProviderWithErrors(
  errors: unknown[],
  chunks: MockChunk[],
  options?: OpenAIChatCompletionsProviderOptions & { model?: string },
): { provider: OpenAIChatCompletionsProvider; requests: unknown[] } {
  const provider = new OpenAIChatCompletionsProvider(
    "test-key",
    options?.model ?? "test-model",
    options,
  );
  const requests: unknown[] = [];
  const pending = [...errors];
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (params: unknown) => {
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

const unsignedToolHistory = [
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

const signedToolHistory = [
  {
    role: "assistant" as const,
    content: [
      {
        type: "tool_use" as const,
        id: "call_1",
        name: "search",
        input: { q: "x" },
        providerMetadata: {
          gemini: { thoughtSignature: "signed-thought-1" },
        },
      },
    ],
  },
];

describe("OpenAIChatCompletionsProvider Gemini thought signature capture", () => {
  test("captures extra_content.google.thought_signature onto tool_use providerMetadata", async () => {
    const { provider } = stubProvider([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_signed",
                  type: "function",
                  function: { name: "file_read" },
                  extra_content: {
                    google: { thought_signature: "signed-thought-1" },
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"path":"/tmp/test"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 8 },
      },
    ]);

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Read /tmp/test" }] },
    ]);

    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "call_signed",
        name: "file_read",
        input: { path: "/tmp/test" },
        providerMetadata: {
          gemini: { thoughtSignature: "signed-thought-1" },
        },
      },
    ]);
  });

  test("captures a thought signature that arrives after the tool call id", async () => {
    const { provider } = stubProvider([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_signed",
                  type: "function",
                  function: { name: "file_read", arguments: '{"path":"/a"}' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  extra_content: {
                    google: { thought_signature: "signed-thought-1" },
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      },
    ]);

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Read /a" }] },
    ]);

    expect(result.content[0]).toEqual({
      type: "tool_use",
      id: "call_signed",
      name: "file_read",
      input: { path: "/a" },
      providerMetadata: {
        gemini: { thoughtSignature: "signed-thought-1" },
      },
    });
  });

  test("does not attach providerMetadata when extra_content is absent", async () => {
    const { provider } = stubProvider([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "search", arguments: '{"q":"x"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
    ]);

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "search" }] },
    ]);

    expect(result.content[0]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "search",
      input: { q: "x" },
    });
  });
});

describe("OpenAIChatCompletionsProvider Gemini thought signature replay", () => {
  test("replays captured thought signatures as extra_content on Gemini 3 models", async () => {
    const { provider, requests } = stubProvider(OK_CHUNKS, {
      model: "gemini-3.7-flash",
    });

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "Read /tmp/test" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_signed",
            name: "file_read",
            input: { path: "/tmp/test" },
            providerMetadata: {
              gemini: { thoughtSignature: "signed-thought-1" },
            },
          },
          {
            type: "tool_use",
            id: "call_unsigned",
            name: "file_read",
            input: { path: "/tmp/other" },
          },
        ],
      },
    ]);

    const params = requests[0] as {
      messages: Array<{
        role: string;
        tool_calls?: Array<{
          id: string;
          type?: string;
          function?: { name: string; arguments: string };
          extra_content?: { google?: { thought_signature?: string } };
        }>;
      }>;
    };
    expect(params.messages[1].tool_calls).toEqual([
      {
        id: "call_signed",
        type: "function",
        function: {
          name: "file_read",
          arguments: JSON.stringify({ path: "/tmp/test" }),
        },
        extra_content: {
          google: { thought_signature: "signed-thought-1" },
        },
      },
      {
        id: "call_unsigned",
        type: "function",
        function: {
          name: "file_read",
          arguments: JSON.stringify({ path: "/tmp/other" }),
        },
      },
    ]);
  });

  test("adds Gemini 3 fallback thought signature to unsigned tool_use history", async () => {
    const { provider, requests } = stubProvider(OK_CHUNKS, {
      model: "gemini-3.7-flash",
    });

    await provider.sendMessage(unsignedToolHistory);

    const params = requests[0] as {
      messages: Array<{
        tool_calls?: Array<{
          extra_content?: { google?: { thought_signature?: string } };
        }>;
      }>;
    };
    expect(params.messages[0].tool_calls?.[0].extra_content).toEqual({
      google: {
        thought_signature: GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE,
      },
    });
  });

  test("does not add extra_content for unsigned history on non-Gemini-3 models", async () => {
    const { provider, requests } = stubProvider(OK_CHUNKS);

    await provider.sendMessage(unsignedToolHistory);

    const params = requests[0] as {
      messages: Array<{
        tool_calls?: Array<{ extra_content?: unknown }>;
      }>;
    };
    expect(params.messages[0].tool_calls?.[0].extra_content).toBeUndefined();
  });

  test("does not replay captured thought signatures onto non-Gemini OpenAI requests", async () => {
    const { provider, requests } = stubProvider(OK_CHUNKS, {
      model: "gpt-5.2",
    });

    await provider.sendMessage(signedToolHistory);

    const params = requests[0] as {
      messages: Array<{
        tool_calls?: Array<{ extra_content?: unknown }>;
      }>;
    };
    expect(params.messages[0].tool_calls?.[0].extra_content).toBeUndefined();
  });
});

describe("missing thought signature rejection fallback", () => {
  test("retries once with a dummy thought signature on unsigned tool_calls", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [rejection("Invalid thought signature")],
      OK_CHUNKS,
    );

    const response = await provider.sendMessage(unsignedToolHistory);

    expect(requests).toHaveLength(2);
    const first = requests[0] as {
      messages: Array<{
        tool_calls?: Array<{ extra_content?: unknown }>;
      }>;
    };
    const second = requests[1] as {
      messages: Array<{
        tool_calls?: Array<{
          extra_content?: { google?: { thought_signature?: string } };
        }>;
      }>;
    };
    expect(first.messages[0].tool_calls?.[0].extra_content).toBeUndefined();
    expect(second.messages[0].tool_calls?.[0].extra_content).toEqual({
      google: {
        thought_signature: GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE,
      },
    });
    expect(response.content.find((b) => b.type === "text")).toEqual({
      type: "text",
      text: "ok",
    });
  });

  test("retries once for an OpenRouter-wrapped missing thought signature rejection", async () => {
    const wrapped = new OpenAI.APIError(
      400,
      {
        code: 400,
        message: "Provider returned error",
        metadata: {
          raw: "[invalid_request_error] Function call search in the 1. content block is missing a thought_signature",
          provider_name: "google",
        },
      },
      undefined,
      new Headers(),
    );
    expect(/thought_signature/i.test(wrapped.message)).toBe(false);

    const { provider, requests } = stubProviderWithErrors([wrapped], OK_CHUNKS);

    await provider.sendMessage(unsignedToolHistory);

    expect(requests).toHaveLength(2);
    expect(
      (
        requests[1] as {
          messages: Array<{
            tool_calls?: Array<{
              extra_content?: { google?: { thought_signature?: string } };
            }>;
          }>;
        }
      ).messages[0].tool_calls?.[0].extra_content?.google?.thought_signature,
    ).toBe(GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE);
  });

  test("retries a remapped model with the captured signature, not the dummy", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [rejection("Invalid thought signature")],
      OK_CHUNKS,
      { model: "vertex-flash" },
    );

    await provider.sendMessage(signedToolHistory);

    expect(requests).toHaveLength(2);
    const first = requests[0] as {
      messages: Array<{
        tool_calls?: Array<{ extra_content?: unknown }>;
      }>;
    };
    const second = requests[1] as {
      messages: Array<{
        tool_calls?: Array<{
          extra_content?: { google?: { thought_signature?: string } };
        }>;
      }>;
    };
    expect(first.messages[0].tool_calls?.[0].extra_content).toBeUndefined();
    expect(second.messages[0].tool_calls?.[0].extra_content).toEqual({
      google: { thought_signature: "signed-thought-1" },
    });
  });

  test("does not retry when Gemini 3 tool_calls already carry a thought signature", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [rejection("Invalid thought signature")],
      OK_CHUNKS,
      { model: "gemini-3.7-flash" },
    );

    await expect(provider.sendMessage(signedToolHistory)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  test("does not retry thought-signature 500s", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [rejection("Invalid thought signature", 500)],
      OK_CHUNKS,
    );

    await expect(provider.sendMessage(unsignedToolHistory)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
});

describe("unknown extra_content rejection fallback", () => {
  test("retries once without extra_content when a strict schema rejects it", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [
        rejection(
          "Additional properties are not allowed ('extra_content' was unexpected)",
        ),
      ],
      OK_CHUNKS,
      { model: "gemini-3.7-flash" },
    );

    await provider.sendMessage(signedToolHistory);

    expect(requests).toHaveLength(2);
    const first = requests[0] as {
      messages: Array<{
        tool_calls?: Array<{ extra_content?: unknown }>;
      }>;
    };
    const second = requests[1] as {
      messages: Array<{
        tool_calls?: Array<{ extra_content?: unknown }>;
      }>;
    };
    expect(first.messages[0].tool_calls?.[0].extra_content).toEqual({
      google: { thought_signature: "signed-thought-1" },
    });
    expect(second.messages[0].tool_calls?.[0].extra_content).toBeUndefined();
  });

  test("does not strip extra_content on a missing thought signature error", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [rejection("Invalid thought signature")],
      OK_CHUNKS,
      { model: "gemini-3.7-flash" },
    );

    await expect(provider.sendMessage(signedToolHistory)).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(
      (
        requests[0] as {
          messages: Array<{
            tool_calls?: Array<{ extra_content?: unknown }>;
          }>;
        }
      ).messages[0].tool_calls?.[0].extra_content,
    ).toEqual({
      google: { thought_signature: "signed-thought-1" },
    });
  });
});

describe("stacked openai-compatible fallback retries", () => {
  test("applies thought-signature backfill then extra_content strip when both 4xx", async () => {
    const { provider, requests } = stubProviderWithErrors(
      [
        rejection("Invalid thought signature"),
        rejection(
          "Additional properties are not allowed ('extra_content' was unexpected)",
        ),
      ],
      OK_CHUNKS,
    );

    const response = await provider.sendMessage(unsignedToolHistory);

    expect(requests).toHaveLength(3);
    const first = requests[0] as {
      messages: Array<{
        tool_calls?: Array<{ extra_content?: unknown }>;
      }>;
    };
    const second = requests[1] as {
      messages: Array<{
        tool_calls?: Array<{ extra_content?: unknown }>;
      }>;
    };
    const third = requests[2] as {
      messages: Array<{
        tool_calls?: Array<{ extra_content?: unknown }>;
      }>;
    };
    expect(first.messages[0].tool_calls?.[0].extra_content).toBeUndefined();
    expect(second.messages[0].tool_calls?.[0].extra_content).toEqual({
      google: {
        thought_signature: GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE,
      },
    });
    expect(third.messages[0].tool_calls?.[0].extra_content).toBeUndefined();
    expect(response.content.find((b) => b.type === "text")).toEqual({
      type: "text",
      text: "ok",
    });
  });
});
