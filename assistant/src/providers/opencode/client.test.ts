import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockDeviceId: string | null = null;
mock.module("../../util/device-id.js", () => ({
  getExistingDeviceId: () => mockDeviceId,
}));

import {
  EMPTY_ASSISTANT_TURN_PLACEHOLDER,
  OpenAIChatCompletionsProvider,
} from "../openai/chat-completions-provider.js";
import { OpenAIResponsesProvider } from "../openai/responses-provider.js";
import type { Message } from "../types.js";
import {
  buildOpenCodeRequestHeaders,
  OPENCODE_GO_BASE_URL,
  OPENCODE_REQUEST_HEADER,
  OPENCODE_RESPONSES_ONLY_MODELS,
  OPENCODE_SESSION_HEADER,
  OPENCODE_ZEN_BASE_URL,
  OpenCodeProvider,
  OpenCodeResponsesProvider,
  resetOpenCodeFallbackSessionForTests,
  resolveOpenCodeBaseURL,
  resolveOpenCodeRequestHeaders,
} from "./client.js";

const USER_TURN: Message[] = [
  { role: "user", content: [{ type: "text", text: "question" }] },
];

/** Stub both wires on an OpenCodeProvider and record which one was called. */
function stubTransports(provider: OpenCodeProvider) {
  const chat: unknown[] = [];
  const responses: Array<{ params: unknown; options: unknown }> = [];
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (params: unknown) => {
          chat.push(params);
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 2, completion_tokens: 1 },
              };
            },
          };
        },
      },
    },
  };
  const inner = (
    provider as unknown as { getResponsesInner(): OpenCodeResponsesProvider }
  ).getResponsesInner();
  (inner as unknown as { client: unknown }).client = {
    responses: {
      create: async (params: unknown, options: unknown) => {
        responses.push({ params, options });
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "response.output_text.delta", delta: "ok" };
            yield {
              type: "response.completed",
              response: {
                status: "completed",
                usage: { input_tokens: 2, output_tokens: 1 },
              },
            };
          },
        };
      },
    },
  };
  return { chat, responses };
}

describe("resolveOpenCodeBaseURL", () => {
  test("defaults to OpenCode Zen", () => {
    expect(resolveOpenCodeBaseURL()).toBe(OPENCODE_ZEN_BASE_URL);
    expect(resolveOpenCodeBaseURL("")).toBe(OPENCODE_ZEN_BASE_URL);
    expect(resolveOpenCodeBaseURL("   ")).toBe(OPENCODE_ZEN_BASE_URL);
  });

  test("keeps a configured origin, including OpenCode Go", () => {
    expect(resolveOpenCodeBaseURL(OPENCODE_GO_BASE_URL)).toBe(
      OPENCODE_GO_BASE_URL,
    );
    expect(resolveOpenCodeBaseURL(" https://example.com/v1 ")).toBe(
      "https://example.com/v1",
    );
  });
});

describe("buildOpenCodeRequestHeaders", () => {
  test("omits headers when ids are missing", () => {
    expect(buildOpenCodeRequestHeaders({})).toEqual({});
    expect(buildOpenCodeRequestHeaders({ conversationId: "  " })).toEqual({});
  });

  test("sets session and request headers without session_id", () => {
    const headers = buildOpenCodeRequestHeaders({
      conversationId: "conv-xyz",
      requestId: "req-123",
    });
    expect(headers[OPENCODE_SESSION_HEADER]).toBe("conv-xyz");
    expect(headers[OPENCODE_REQUEST_HEADER]).toBe("req-123");
    expect(headers).not.toHaveProperty("session_id");
  });

  test("falls back to the stable device id when there is no conversation", () => {
    expect(
      buildOpenCodeRequestHeaders({ fallbackSessionId: "dev-123" }),
    ).toEqual({ [OPENCODE_SESSION_HEADER]: "dev-123" });
  });

  test("conversation id wins over the fallback session id", () => {
    expect(
      buildOpenCodeRequestHeaders({
        conversationId: "conv-xyz",
        fallbackSessionId: "dev-123",
      }),
    ).toEqual({ [OPENCODE_SESSION_HEADER]: "conv-xyz" });
  });

  test("blank conversation id falls through to the fallback session id", () => {
    expect(
      buildOpenCodeRequestHeaders({
        conversationId: "   ",
        fallbackSessionId: "dev-123",
      }),
    ).toEqual({ [OPENCODE_SESSION_HEADER]: "dev-123" });
  });

  test("sets only the ids that are present", () => {
    expect(buildOpenCodeRequestHeaders({ conversationId: "conv-xyz" })).toEqual(
      { [OPENCODE_SESSION_HEADER]: "conv-xyz" },
    );
    expect(buildOpenCodeRequestHeaders({ requestId: "req-123" })).toEqual({
      [OPENCODE_REQUEST_HEADER]: "req-123",
    });
  });
});

describe("resolveOpenCodeRequestHeaders", () => {
  beforeEach(() => {
    mockDeviceId = null;
    resetOpenCodeFallbackSessionForTests();
  });

  test("uses the conversation id over the device id", () => {
    mockDeviceId = "dev-123";
    const headers = resolveOpenCodeRequestHeaders("conv-xyz");
    expect(headers[OPENCODE_SESSION_HEADER]).toBe("conv-xyz");
    expect(headers[OPENCODE_REQUEST_HEADER]).toMatch(/\S/);
    expect(resolveOpenCodeRequestHeaders()[OPENCODE_SESSION_HEADER]).toBe(
      "dev-123",
    );
  });

  test("mints one process-stable session when there is no device id", () => {
    const first = resolveOpenCodeRequestHeaders();
    expect(first[OPENCODE_SESSION_HEADER]).toMatch(/\S/);
    expect(first).not.toHaveProperty("session_id");
    // Pinned: a device.json created later in the process does not move
    // background traffic onto a second session.
    mockDeviceId = "dev-123";
    expect(resolveOpenCodeRequestHeaders()[OPENCODE_SESSION_HEADER]).toBe(
      first[OPENCODE_SESSION_HEADER]!,
    );
  });
});

describe("OpenCodeProvider", () => {
  test("uses OpenAI chat-completions with reasoning-compatible knobs", () => {
    const provider = new OpenCodeProvider("sk-test", "mimo-v2.5-free");
    expect(provider).toBeInstanceOf(OpenAIChatCompletionsProvider);
    expect(provider.name).toBe("opencode");
    expect(
      (provider as unknown as { assistantReasoningField?: string })
        .assistantReasoningField,
    ).toBe("reasoning_content");
    expect(
      (provider as unknown as { omitToolChoiceWhenReasoning: boolean })
        .omitToolChoiceWhenReasoning,
    ).toBe(true);
  });

  test("merges per-request OpenCode headers onto the transport", async () => {
    const provider = new OpenCodeProvider("sk-test", "mimo-v2.5-free");
    const seen: Array<{ params: unknown; options: unknown }> = [];
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async (params: unknown, options: unknown) => {
            seen.push({ params, options });
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  choices: [
                    { delta: { content: "ok" }, finish_reason: "stop" },
                  ],
                  usage: { prompt_tokens: 2, completion_tokens: 1 },
                };
              },
            };
          },
        },
      },
    };

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "question" }] }],
      {
        config: {
          requestHeaders: {
            [OPENCODE_SESSION_HEADER]: "conv-xyz",
            [OPENCODE_REQUEST_HEADER]: "req-123",
          },
        },
      },
    );

    const options = seen[0]!.options as { headers?: Record<string, string> };
    expect(options.headers?.[OPENCODE_SESSION_HEADER]).toBe("conv-xyz");
    expect(options.headers?.[OPENCODE_REQUEST_HEADER]).toBe("req-123");
    expect(options.headers).not.toHaveProperty("session_id");
  });

  test("stamps session and request headers on a configless call", async () => {
    const provider = new OpenCodeProvider("sk-test", "mimo-v2.5-free");
    const seen: Array<{ options: unknown }> = [];
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async (_params: unknown, options: unknown) => {
            seen.push({ options });
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  choices: [
                    { delta: { content: "ok" }, finish_reason: "stop" },
                  ],
                  usage: { prompt_tokens: 2, completion_tokens: 1 },
                };
              },
            };
          },
        },
      },
    };

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "question" }] },
    ]);

    const options = seen[0]!.options as { headers?: Record<string, string> };
    expect(options.headers?.[OPENCODE_SESSION_HEADER]).toMatch(/\S/);
    expect(options.headers?.[OPENCODE_REQUEST_HEADER]).toMatch(/\S/);
    expect(options.headers).not.toHaveProperty("session_id");
  });

  test("backfills placeholder content after an aborted empty assistant turn", async () => {
    const provider = new OpenCodeProvider("sk-test", "mimo-v2.5-free");
    const requests: unknown[] = [];
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            requests.push(params);
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  choices: [
                    { delta: { content: "ok" }, finish_reason: "stop" },
                  ],
                  usage: { prompt_tokens: 2, completion_tokens: 1 },
                };
              },
            };
          },
        },
      },
    };

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "assistant", content: [] },
    ]);

    const params = requests[0] as {
      messages: Array<{ role: string; content: string | null }>;
    };
    const assistantMsg = params.messages.find((m) => m.role === "assistant")!;
    expect(assistantMsg.content).toBe(EMPTY_ASSISTANT_TURN_PLACEHOLDER);
  });
});

describe("OPENCODE_RESPONSES_ONLY_MODELS", () => {
  test("lists the verified responses-only models and nothing else", () => {
    expect([...OPENCODE_RESPONSES_ONLY_MODELS].sort()).toEqual([
      "muse-spark-1.2-contributor-free",
      "muse-spark-1.3-contributor-free",
    ]);
  });
});

describe("OpenCodeResponsesProvider", () => {
  test("is the Responses transport under the opencode name on OpenCode Zen", () => {
    const provider = new OpenCodeResponsesProvider(
      "sk-test",
      "muse-spark-1.2-contributor-free",
    );
    expect(provider).toBeInstanceOf(OpenAIResponsesProvider);
    expect(provider.name).toBe("opencode");
    expect(
      (provider as unknown as { client: { baseURL?: string } }).client.baseURL,
    ).toBe(OPENCODE_ZEN_BASE_URL);
  });

  test("keeps a configured OpenCode Go origin", () => {
    const provider = new OpenCodeResponsesProvider(
      "sk-test",
      "muse-spark-1.2-contributor-free",
      { baseURL: OPENCODE_GO_BASE_URL },
    );
    expect(
      (provider as unknown as { client: { baseURL?: string } }).client.baseURL,
    ).toBe(OPENCODE_GO_BASE_URL);
  });
});

describe("OpenCodeProvider transport selection", () => {
  beforeEach(() => {
    mockDeviceId = null;
    resetOpenCodeFallbackSessionForTests();
  });

  test("sends a responses-only model through the Responses API with the caller's OpenCode headers", async () => {
    const provider = new OpenCodeProvider(
      "sk-test",
      "muse-spark-1.2-contributor-free",
    );
    const { chat, responses } = stubTransports(provider);

    const result = await provider.sendMessage(USER_TURN, {
      config: {
        requestHeaders: {
          [OPENCODE_SESSION_HEADER]: "conv-xyz",
          [OPENCODE_REQUEST_HEADER]: "req-123",
        },
      },
    });

    expect(chat).toHaveLength(0);
    expect(responses).toHaveLength(1);
    expect((responses[0]!.params as { model: string }).model).toBe(
      "muse-spark-1.2-contributor-free",
    );
    const options = responses[0]!.options as {
      headers?: Record<string, string>;
    };
    expect(options.headers?.[OPENCODE_SESSION_HEADER]).toBe("conv-xyz");
    expect(options.headers?.[OPENCODE_REQUEST_HEADER]).toBe("req-123");
    expect(options.headers).not.toHaveProperty("session_id");
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("stamps the session backstop on a configless Responses call", async () => {
    mockDeviceId = "device-abc";
    const provider = new OpenCodeProvider(
      "sk-test",
      "muse-spark-1.2-contributor-free",
    );
    const { responses } = stubTransports(provider);

    await provider.sendMessage(USER_TURN);

    const options = responses[0]!.options as {
      headers?: Record<string, string>;
    };
    expect(options.headers?.[OPENCODE_SESSION_HEADER]).toBe("device-abc");
    expect(options.headers?.[OPENCODE_REQUEST_HEADER]).toBeTruthy();
  });

  test("keeps a chat-completions model on the chat wire", async () => {
    const provider = new OpenCodeProvider("sk-test", "mimo-v2.5-free");
    const { chat, responses } = stubTransports(provider);

    await provider.sendMessage(USER_TURN);

    expect(chat).toHaveLength(1);
    expect(responses).toHaveLength(0);
  });

  test("a per-call model override picks the transport that model needs", async () => {
    const provider = new OpenCodeProvider("sk-test", "mimo-v2.5-free");
    const { chat, responses } = stubTransports(provider);

    await provider.sendMessage(USER_TURN, {
      config: { model: "muse-spark-1.2-contributor-free" },
    });

    expect(chat).toHaveLength(0);
    expect(responses).toHaveLength(1);
    expect((responses[0]!.params as { model: string }).model).toBe(
      "muse-spark-1.2-contributor-free",
    );
  });
});
