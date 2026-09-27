import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";
import { RetryProvider } from "../retry.js";
import type { Message, SendMessageOptions } from "../types.js";
import {
  FIREWORKS_SESSION_AFFINITY_HEADER,
  FireworksProvider,
  resolveFireworksRequestHeaders,
} from "./client.js";

const USER_TURN: Message[] = [
  { role: "user", content: [{ type: "text", text: "question" }] },
];

interface WireCall {
  params: Record<string, unknown>;
  headers: Record<string, string> | undefined;
}

/** Replace the SDK client so each chat-completions call is recorded. */
function stubChatCompletions(provider: OpenAIChatCompletionsProvider) {
  const calls: WireCall[] = [];
  (provider as unknown as { client: unknown }).client = {
    baseURL: "https://api.fireworks.example/inference/v1",
    chat: {
      completions: {
        create: async (
          params: Record<string, unknown>,
          options?: { headers?: Record<string, string> },
        ) => {
          calls.push({ params, headers: options?.headers });
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
  return calls;
}

function fireworksPipeline() {
  const inner = new FireworksProvider(
    "fw-test",
    "accounts/fireworks/models/example-model",
  );
  const calls = stubChatCompletions(inner);
  return { provider: new RetryProvider(inner), calls };
}

async function send(
  provider: RetryProvider,
  config: SendMessageOptions["config"],
): Promise<void> {
  await provider.sendMessage(USER_TURN, { config });
}

beforeEach(() => {
  setConfig("llm", {});
});

describe("resolveFireworksRequestHeaders", () => {
  test("sets the session affinity header from the key", () => {
    expect(resolveFireworksRequestHeaders("conv-xyz")).toEqual({
      [FIREWORKS_SESSION_AFFINITY_HEADER]: "conv-xyz",
    });
  });

  test("omits the header without a usable key", () => {
    expect(resolveFireworksRequestHeaders(undefined)).toEqual({});
    expect(resolveFireworksRequestHeaders("   ")).toEqual({});
  });
});

describe("Fireworks session affinity on the wire", () => {
  test("sends the selectionSeed as x-session-affinity and keeps it out of the body", async () => {
    const { provider, calls } = fireworksPipeline();

    await send(provider, {
      selectionSeed: "conv-seed",
      conversationId: "conv-other",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers?.[FIREWORKS_SESSION_AFFINITY_HEADER]).toBe(
      "conv-seed",
    );
    const body = JSON.stringify(calls[0]!.params);
    expect(body).not.toContain(FIREWORKS_SESSION_AFFINITY_HEADER);
    expect(body).not.toContain("conv-seed");
    expect(body).not.toContain("conv-other");
    expect(calls[0]!.params).not.toHaveProperty("requestHeaders");
    expect(calls[0]!.params).not.toHaveProperty("user");
  });

  test("falls back to conversationId when there is no selectionSeed", async () => {
    const { provider, calls } = fireworksPipeline();

    await send(provider, { conversationId: "conv-xyz" });

    expect(calls[0]!.headers?.[FIREWORKS_SESSION_AFFINITY_HEADER]).toBe(
      "conv-xyz",
    );
    expect(JSON.stringify(calls[0]!.params)).not.toContain("conv-xyz");
  });

  test("uses the same key on every call of a conversation", async () => {
    const { provider, calls } = fireworksPipeline();

    await send(provider, { selectionSeed: "conv-xyz" });
    await send(provider, { selectionSeed: "conv-xyz" });

    expect(
      calls.map((call) => call.headers?.[FIREWORKS_SESSION_AFFINITY_HEADER]),
    ).toEqual(["conv-xyz", "conv-xyz"]);
  });

  test("sends no header when the call has no conversation key", async () => {
    const { provider, calls } = fireworksPipeline();

    await send(provider, {});
    await send(provider, { selectionSeed: "  ", conversationId: "" });

    for (const call of calls) {
      expect(call.headers ?? {}).not.toHaveProperty(
        FIREWORKS_SESSION_AFFINITY_HEADER,
      );
    }
  });

  test("ignores caller-set request headers", async () => {
    const { provider, calls } = fireworksPipeline();

    await send(provider, {
      requestHeaders: { [FIREWORKS_SESSION_AFFINITY_HEADER]: "shared-key" },
    });

    expect(calls[0]!.headers ?? {}).not.toHaveProperty(
      FIREWORKS_SESSION_AFFINITY_HEADER,
    );
  });

  test("does not send the header for other chat-completions providers", async () => {
    const inner = new OpenAIChatCompletionsProvider("sk-test", "some-model", {
      providerName: "together",
      providerLabel: "Together",
    });
    const calls = stubChatCompletions(inner);
    const provider = new RetryProvider(inner);

    await send(provider, {
      selectionSeed: "conv-xyz",
      conversationId: "conv-xyz",
    });

    expect(calls[0]!.headers ?? {}).not.toHaveProperty(
      FIREWORKS_SESSION_AFFINITY_HEADER,
    );
    expect(JSON.stringify(calls[0]!.params)).not.toContain("conv-xyz");
  });
});
