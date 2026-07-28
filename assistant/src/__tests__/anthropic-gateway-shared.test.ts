import { describe, expect, test } from "bun:test";

import {
  isAnthropicDelegatingGateway,
  isAnthropicModel,
  retagDelegateError,
  toAnthropicMessagesBaseURL,
} from "../providers/anthropic-gateway-shared.js";
import { ContextOverflowError } from "../providers/types.js";
import { ProviderError } from "../util/errors.js";

describe("isAnthropicModel", () => {
  test("true for anthropic/-prefixed models", () => {
    expect(isAnthropicModel("anthropic/claude-opus-4.8")).toBe(true);
  });

  test("false otherwise", () => {
    expect(isAnthropicModel("openai/gpt-5.5")).toBe(false);
  });
});

describe("toAnthropicMessagesBaseURL", () => {
  test("strips a trailing /v1", () => {
    expect(toAnthropicMessagesBaseURL("https://ai-gateway.vercel.sh/v1")).toBe(
      "https://ai-gateway.vercel.sh",
    );
  });

  test("strips a trailing /v1/", () => {
    expect(toAnthropicMessagesBaseURL("https://openrouter.ai/api/v1/")).toBe(
      "https://openrouter.ai/api",
    );
  });

  test("leaves URLs without a /v1 suffix untouched", () => {
    expect(toAnthropicMessagesBaseURL("https://ai-gateway.vercel.sh")).toBe(
      "https://ai-gateway.vercel.sh",
    );
  });
});

describe("isAnthropicDelegatingGateway", () => {
  test("true for the gateways that front Anthropic's Messages API", () => {
    expect(isAnthropicDelegatingGateway("openrouter")).toBe(true);
    expect(isAnthropicDelegatingGateway("vercel-ai-gateway")).toBe(true);
  });

  test("false for other providers", () => {
    expect(isAnthropicDelegatingGateway("anthropic")).toBe(false);
    expect(isAnthropicDelegatingGateway("openai")).toBe(false);
  });
});

describe("retagDelegateError", () => {
  // The provider name is opaque to retagDelegateError; one gateway name
  // exercises the full behavior.
  const providerName = "vercel-ai-gateway";

  test("re-tags a delegate ProviderError, preserving metadata", () => {
    const inner = new ProviderError("rate limited", "anthropic", 429, {
      retryAfterMs: 1_500,
      abortReason: "test-abort",
    });

    let caught: unknown;
    try {
      retagDelegateError(inner, providerName);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;
    expect(err.provider).toBe(providerName);
    expect(err.message).toBe("rate limited");
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBe(1_500);
    expect(err.abortReason).toBe("test-abort");
    expect(err.cause).toBe(inner);
  });

  test("carries reason + structured fields across the re-tag", () => {
    const inner = new ProviderError("model restricted", "anthropic", 403, {
      reason: "model_restricted",
      apiErrorType: "permission_error",
      apiErrorCode: "restricted",
      apiErrorParam: "model",
      rawBody: '{"type":"error"}',
    });

    let caught: unknown;
    try {
      retagDelegateError(inner, providerName);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;
    expect(err.provider).toBe(providerName);
    expect(err.reason).toBe("model_restricted");
    expect(err.apiErrorType).toBe("permission_error");
    expect(err.apiErrorCode).toBe("restricted");
    expect(err.apiErrorParam).toBe("model");
    expect(err.rawBody).toBe('{"type":"error"}');
  });

  test("re-tags a delegate ContextOverflowError, preserving token counts", () => {
    const inner = new ContextOverflowError("context overflow", "anthropic", {
      actualTokens: 250_000,
      maxTokens: 200_000,
      statusCode: 400,
    });

    let caught: unknown;
    try {
      retagDelegateError(inner, providerName);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ContextOverflowError);
    const err = caught as ContextOverflowError;
    expect(err.provider).toBe(providerName);
    expect(err.actualTokens).toBe(250_000);
    expect(err.maxTokens).toBe(200_000);
    expect(err.statusCode).toBe(400);
    expect(err.cause).toBe(inner);
  });

  test("rethrows an already-tagged error unchanged", () => {
    const inner = new ProviderError("boom", providerName, 500);
    expect(() => retagDelegateError(inner, providerName)).toThrow(inner);
  });

  test("rethrows non-provider errors unchanged", () => {
    const inner = new Error("plain failure");
    expect(() => retagDelegateError(inner, providerName)).toThrow(inner);
  });
});
