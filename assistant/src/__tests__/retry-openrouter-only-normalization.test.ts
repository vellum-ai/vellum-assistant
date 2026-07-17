/**
 * Verifies that `RetryProvider.normalizeSendMessageOptions` plumbs
 * `openrouter.only` only to the `openrouter` provider and strips it for every
 * other provider — so strict-schema clients (Anthropic, OpenAI, …) never see
 * the unknown field on the wire.
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

function setLlmConfig(raw: unknown): void {
  setConfig("llm", raw);
}

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

describe("retry normalization for openrouter.only", () => {
  test("forwards openrouter.only on the outbound config for openrouter", async () => {
    setLlmConfig({
      callSites: {
        mainAgent: {
          provider: "openrouter",
          model: "anthropic/claude-opus-4.7",
          openrouter: { only: ["Anthropic"] },
        },
      },
    });
    const { provider, lastConfig } = makePipeline("openrouter");
    await provider.sendMessage([userMessage], {
      config: { callSite: "mainAgent" },
    });
    expect(lastConfig()?.openrouter).toEqual({ only: ["Anthropic"] });
  });

  test("omits openrouter from config when resolved list is empty", async () => {
    setLlmConfig({
      callSites: {
        mainAgent: {
          provider: "openrouter",
          model: "anthropic/claude-opus-4.7",
        },
      },
    });
    const { provider, lastConfig } = makePipeline("openrouter");
    await provider.sendMessage([userMessage], {
      config: { callSite: "mainAgent" },
    });
    expect(lastConfig()?.openrouter).toBe(undefined);
  });

  test("strips openrouter from config for non-openrouter providers", async () => {
    const { provider, lastConfig } = makePipeline("anthropic");
    await provider.sendMessage([userMessage], {
      config: { openrouter: { only: ["Anthropic"] } },
    });
    const out = lastConfig();
    expect(out?.openrouter).toBe(undefined);
  });

  test("strips openrouter from config for openai provider", async () => {
    const { provider, lastConfig } = makePipeline("openai");
    await provider.sendMessage([userMessage], {
      config: { openrouter: { only: ["Anthropic"] } },
    });
    expect(lastConfig()?.openrouter).toBe(undefined);
  });

  test("call-site override replaces the winning profile's openrouter.only", async () => {
    setLlmConfig({
      profiles: {
        "openrouter-profile": {
          source: "user",
          provider: "openrouter",
          model: "anthropic/claude-opus-4.7",
          openrouter: { only: ["Anthropic"] },
        },
      },
      activeProfile: "openrouter-profile",
      callSites: {
        mainAgent: { openrouter: { only: ["Google"] } },
      },
    });
    const { provider, lastConfig } = makePipeline("openrouter");
    await provider.sendMessage([userMessage], {
      config: { callSite: "mainAgent" },
    });
    expect(lastConfig()?.openrouter).toEqual({ only: ["Google"] });
  });
});
