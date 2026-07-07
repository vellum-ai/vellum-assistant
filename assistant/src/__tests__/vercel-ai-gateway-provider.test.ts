import { describe, expect, test } from "bun:test";

import type { AnthropicProvider } from "../providers/anthropic/client.js";
import type { Message } from "../providers/types.js";
import { ContextOverflowError } from "../providers/types.js";
import {
  toAnthropicMessagesBaseURL,
  VercelAIGatewayProvider,
} from "../providers/vercel-ai-gateway/client.js";
import { ProviderError } from "../util/errors.js";

const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1";

function resolvedBaseURL(provider: VercelAIGatewayProvider): string {
  return (provider as unknown as { resolvedBaseURL: string }).resolvedBaseURL;
}

function stubAnthropicInner(
  provider: VercelAIGatewayProvider,
  sendMessage: AnthropicProvider["sendMessage"],
): void {
  (
    provider as unknown as { anthropicInner: AnthropicProvider }
  ).anthropicInner = { sendMessage } as unknown as AnthropicProvider;
}

const USER_MESSAGE: Message[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

describe("VercelAIGatewayProvider", () => {
  describe("constructor baseURL resolution", () => {
    test("defaults to the Vercel AI Gateway base URL", () => {
      const provider = new VercelAIGatewayProvider(
        "fake-key",
        "openai/gpt-5.5",
      );
      expect(resolvedBaseURL(provider)).toBe(DEFAULT_BASE_URL);
    });

    test("an explicit baseURL option wins", () => {
      const provider = new VercelAIGatewayProvider(
        "fake-key",
        "openai/gpt-5.5",
        { baseURL: "https://proxy.example.com/v1" },
      );
      expect(resolvedBaseURL(provider)).toBe("https://proxy.example.com/v1");
    });

    test("a blank baseURL falls back to the default", () => {
      const provider = new VercelAIGatewayProvider(
        "fake-key",
        "openai/gpt-5.5",
        { baseURL: "   " },
      );
      expect(resolvedBaseURL(provider)).toBe(DEFAULT_BASE_URL);
    });
  });

  describe("toAnthropicMessagesBaseURL", () => {
    test("strips a trailing /v1", () => {
      expect(toAnthropicMessagesBaseURL("https://ai-gateway.vercel.sh/v1")).toBe(
        "https://ai-gateway.vercel.sh",
      );
    });

    test("strips a trailing /v1/", () => {
      expect(
        toAnthropicMessagesBaseURL("https://ai-gateway.vercel.sh/v1/"),
      ).toBe("https://ai-gateway.vercel.sh");
    });

    test("leaves URLs without a /v1 suffix untouched", () => {
      expect(toAnthropicMessagesBaseURL("https://ai-gateway.vercel.sh")).toBe(
        "https://ai-gateway.vercel.sh",
      );
    });
  });

  describe("tokenEstimationProvider", () => {
    test("returns anthropic for anthropic/* default models", () => {
      const provider = new VercelAIGatewayProvider(
        "fake-key",
        "anthropic/claude-opus-4.8",
      );
      expect(provider.tokenEstimationProvider).toBe("anthropic");
    });

    test("returns vercel-ai-gateway otherwise", () => {
      const provider = new VercelAIGatewayProvider(
        "fake-key",
        "openai/gpt-5.5",
      );
      expect(provider.tokenEstimationProvider).toBe("vercel-ai-gateway");
    });
  });

  describe("supportsNativeWebSearch", () => {
    test("true when enabled and the default model is anthropic/*", () => {
      const provider = new VercelAIGatewayProvider(
        "fake-key",
        "anthropic/claude-opus-4.8",
        { useNativeWebSearch: true },
      );
      expect(provider.supportsNativeWebSearch).toBe(true);
    });

    test("false for a non-anthropic model even when enabled", () => {
      const provider = new VercelAIGatewayProvider(
        "fake-key",
        "openai/gpt-5.5",
        { useNativeWebSearch: true },
      );
      expect(provider.supportsNativeWebSearch).toBe(false);
    });

    test("false when disabled, even for an anthropic model", () => {
      const provider = new VercelAIGatewayProvider(
        "fake-key",
        "anthropic/claude-opus-4.8",
      );
      expect(provider.supportsNativeWebSearch).toBe(false);
    });
  });

  describe("delegate error re-tagging", () => {
    test("rethrows a delegate ProviderError tagged with vercel-ai-gateway", async () => {
      const provider = new VercelAIGatewayProvider(
        "fake-key",
        "anthropic/claude-opus-4.8",
      );
      const inner = new ProviderError("rate limited", "anthropic", 429, {
        retryAfterMs: 1_500,
      });
      stubAnthropicInner(provider, async () => {
        throw inner;
      });

      let caught: unknown;
      try {
        await provider.sendMessage(USER_MESSAGE);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ProviderError);
      const err = caught as ProviderError;
      expect(err.provider).toBe("vercel-ai-gateway");
      expect(err.message).toBe("rate limited");
      expect(err.statusCode).toBe(429);
      expect(err.retryAfterMs).toBe(1_500);
      expect(err.cause).toBe(inner);
    });

    test("rethrows a delegate ContextOverflowError preserving token counts", async () => {
      const provider = new VercelAIGatewayProvider(
        "fake-key",
        "anthropic/claude-opus-4.8",
      );
      const inner = new ContextOverflowError("context overflow", "anthropic", {
        actualTokens: 250_000,
        maxTokens: 200_000,
        statusCode: 400,
      });
      stubAnthropicInner(provider, async () => {
        throw inner;
      });

      let caught: unknown;
      try {
        await provider.sendMessage(USER_MESSAGE);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ContextOverflowError);
      const err = caught as ContextOverflowError;
      expect(err.provider).toBe("vercel-ai-gateway");
      expect(err.actualTokens).toBe(250_000);
      expect(err.maxTokens).toBe(200_000);
      expect(err.statusCode).toBe(400);
      expect(err.cause).toBe(inner);
    });
  });
});
