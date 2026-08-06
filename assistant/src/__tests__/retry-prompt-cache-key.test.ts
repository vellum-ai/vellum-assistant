/**
 * Verifies that `RetryProvider.normalizeSendMessageOptions` copies
 * `selectionSeed` (the durable conversation id) into `promptCacheKey` for the
 * `openai` provider only — and never for providers whose clients spread config
 * into wire request bodies (Anthropic 400s unknown fields).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { RetryProvider } from "../providers/retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import { setConfig } from "./helpers/set-config.js";

beforeEach(() => {
  setConfig("llm", {});
});

function makePipeline(providerName: string): {
  provider: Provider;
  lastConfig: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const inner: Provider = {
    name: providerName,
    async sendMessage(
      _messages: Message[],
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      captured = options?.config as Record<string, unknown> | undefined;
      return {
        content: [],
        model: "test",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "stop",
      };
    },
  };
  return {
    provider: new RetryProvider(inner),
    lastConfig: () => captured,
  };
}

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

describe("retry normalization for promptCacheKey", () => {
  test("copies selectionSeed into promptCacheKey for openai and strips the seed", async () => {
    const { provider, lastConfig } = makePipeline("openai");
    await provider.sendMessage([userMessage], {
      config: { selectionSeed: "conv-1" },
    });

    expect(lastConfig()?.promptCacheKey).toBe("conv-1");
    expect(lastConfig()?.selectionSeed).toBeUndefined();
  });

  test("does not create promptCacheKey for anthropic", async () => {
    const { provider, lastConfig } = makePipeline("anthropic");
    await provider.sendMessage([userMessage], {
      config: { selectionSeed: "conv-1" },
    });

    expect(lastConfig()?.promptCacheKey).toBeUndefined();
    expect(lastConfig()?.selectionSeed).toBeUndefined();
  });

  test("copies selectionSeed into promptCacheKey for openrouter", async () => {
    // OpenRouter's openai/* Responses delegate consumes the key. Its
    // anthropic/* delegation path receives the same config, so the Anthropic
    // client strips `promptCacheKey` from the wire (see
    // anthropic-provider.test.ts "promptCacheKey is not forwarded").
    const { provider, lastConfig } = makePipeline("openrouter");
    await provider.sendMessage([userMessage], {
      config: { selectionSeed: "conv-1" },
    });

    expect(lastConfig()?.promptCacheKey).toBe("conv-1");
    expect(lastConfig()?.selectionSeed).toBeUndefined();
  });

  test("no selectionSeed → no promptCacheKey", async () => {
    const { provider, lastConfig } = makePipeline("openai");
    await provider.sendMessage([userMessage], { config: {} });

    expect(lastConfig()?.promptCacheKey).toBeUndefined();
  });

  test("an explicit caller-set promptCacheKey wins over the seed copy", async () => {
    const { provider, lastConfig } = makePipeline("openai");
    await provider.sendMessage([userMessage], {
      config: { selectionSeed: "conv-1", promptCacheKey: "explicit-key" },
    });

    expect(lastConfig()?.promptCacheKey).toBe("explicit-key");
  });

  test("callSite resolution still runs and the key survives it", async () => {
    setConfig("llm", {
      default: { provider: "openai", model: "gpt-5.6-sol" },
    });
    const { provider, lastConfig } = makePipeline("openai");
    await provider.sendMessage([userMessage], {
      config: { callSite: "mainAgent", selectionSeed: "conv-1" },
    });

    // The resolver populated wire fields (exact model depends on the active
    // resolution cascade — not this test's concern) and the routing keys were
    // consumed, while the copied prompt-cache key survived normalization.
    expect(typeof lastConfig()?.model).toBe("string");
    expect((lastConfig()?.model as string).length).toBeGreaterThan(0);
    expect(lastConfig()?.promptCacheKey).toBe("conv-1");
    expect(lastConfig()?.callSite).toBeUndefined();
    expect(lastConfig()?.selectionSeed).toBeUndefined();
  });
});
