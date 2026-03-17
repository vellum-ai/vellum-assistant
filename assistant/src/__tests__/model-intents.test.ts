import { describe, expect, test } from "bun:test";

import {
  getProviderDefaultModel,
  isModelIntent,
  resolveModelIntent,
} from "../providers/model-intents.js";
import { RetryProvider } from "../providers/retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";

const DUMMY_MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

function makeResponse(model: string): ProviderResponse {
  return {
    content: [{ type: "text", text: "ok" }],
    model,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
    },
    stopReason: "end_turn",
  };
}

function makeProvider(
  name: string,
  onCall: (options: SendMessageOptions | undefined) => void,
): Provider {
  return {
    name,
    async sendMessage(_messages, _tools, _systemPrompt, options) {
      onCall(options);
      const config = options?.config as Record<string, unknown> | undefined;
      return makeResponse(
        (config?.model as string | undefined) ?? "default-model",
      );
    },
  };
}

describe("model intents", () => {
  test("validates model intent strings", () => {
    expect(isModelIntent("latency-optimized")).toBe(true);
    expect(isModelIntent("quality-optimized")).toBe(true);
    expect(isModelIntent("vision-optimized")).toBe(true);
    expect(isModelIntent("fastest-model")).toBe(false);
    expect(isModelIntent(undefined)).toBe(false);
  });

  test("resolves intent to provider-specific model", () => {
    expect(resolveModelIntent("anthropic", "latency-optimized")).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(resolveModelIntent("anthropic", "quality-optimized")).toBe(
      "claude-opus-4-6",
    );
    expect(resolveModelIntent("anthropic", "vision-optimized")).toBe(
      "claude-opus-4-6",
    );
    expect(resolveModelIntent("openai", "latency-optimized")).toBe(
      "gpt-4o-mini",
    );
  });

  test("falls back to provider default for unknown providers", () => {
    expect(getProviderDefaultModel("unknown-provider")).toBe("claude-opus-4-6");
    expect(resolveModelIntent("unknown-provider", "quality-optimized")).toBe(
      "claude-opus-4-6",
    );
  });
});

describe("RetryProvider model intent normalization", () => {
  test("translates modelIntent into concrete model and strips modelIntent key", async () => {
    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: {
        modelIntent: "quality-optimized",
        max_tokens: 123,
      },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("claude-opus-4-6");
    expect(config.modelIntent).toBeUndefined();
    expect(config.max_tokens).toBe(123);
  });

  test("explicit model override wins over modelIntent", async () => {
    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("openai", (options) => {
        seen = options;
      }),
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: {
        model: "custom-model-v1",
        modelIntent: "latency-optimized",
      },
    });

    const config = seen?.config as Record<string, unknown>;
    expect(config.model).toBe("custom-model-v1");
    expect(config.modelIntent).toBeUndefined();
  });
});
