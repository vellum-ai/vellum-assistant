import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockDeviceId: string | null = null;
mock.module("../../util/device-id.js", () => ({
  getExistingDeviceId: () => mockDeviceId,
}));

import {
  EMPTY_ASSISTANT_TURN_PLACEHOLDER,
  OpenAIChatCompletionsProvider,
} from "../openai/chat-completions-provider.js";
import {
  buildOpenCodeRequestHeaders,
  OPENCODE_GO_BASE_URL,
  OPENCODE_REQUEST_HEADER,
  OPENCODE_SESSION_HEADER,
  OPENCODE_ZEN_BASE_URL,
  OpenCodeProvider,
  resetOpenCodeFallbackSessionForTests,
  resolveOpenCodeBaseURL,
  resolveOpenCodeRequestHeaders,
} from "./client.js";

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
