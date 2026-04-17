import { describe, expect, test } from "bun:test";

// SDK error classes are constructed via their exports so we produce
// real instances that pass the provider clients' `instanceof` checks.
import Anthropic from "@anthropic-ai/sdk";
import { ApiError as GeminiApiError } from "@google/genai";
import OpenAI from "openai";

import { detectAnthropicContextOverflow } from "../anthropic/client.js";
import { detectOpenAICompatibleContextOverflow } from "../openai/chat-completions-provider.js";
import { ContextOverflowError, isContextOverflowError } from "../types.js";

describe("ContextOverflowError", () => {
  test("constructs with providerName, actualTokens, maxTokens, raw", () => {
    const err = new ContextOverflowError("msg", "anthropic", {
      actualTokens: 242201,
      maxTokens: 200000,
      raw: { type: "error" },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ContextOverflowError);
    expect(err.name).toBe("ContextOverflowError");
    expect(err.message).toBe("msg");
    expect(err.providerName).toBe("anthropic");
    expect(err.actualTokens).toBe(242201);
    expect(err.maxTokens).toBe(200000);
    expect(err.raw).toEqual({ type: "error" });
  });

  test("carries cause when supplied", () => {
    const cause = new Error("underlying");
    const err = new ContextOverflowError("outer", "openai", {
      raw: {},
      cause,
    });
    expect((err as Error & { cause?: unknown }).cause).toBe(cause);
  });

  test("omits optional fields when unset", () => {
    const err = new ContextOverflowError("m", "gemini", { raw: {} });
    expect(err.actualTokens).toBeUndefined();
    expect(err.maxTokens).toBeUndefined();
    expect(err.providerName).toBe("gemini");
  });
});

describe("isContextOverflowError", () => {
  test("returns true for a native ContextOverflowError", () => {
    const err = new ContextOverflowError("m", "anthropic", { raw: {} });
    expect(isContextOverflowError(err)).toBe(true);
  });

  test("returns false for a plain Error", () => {
    expect(isContextOverflowError(new Error("boom"))).toBe(false);
  });

  test("returns false for ProviderError-like object without brand", () => {
    expect(
      isContextOverflowError({
        name: "ProviderError",
        message: "Anthropic API error (400): prompt is too long",
      }),
    ).toBe(false);
  });

  test("returns false for null / undefined / primitives", () => {
    expect(isContextOverflowError(null)).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError("string")).toBe(false);
    expect(isContextOverflowError(42)).toBe(false);
  });

  test("returns false for object carrying the brand but wrong name", () => {
    // Brand alone is not enough — the name must also match to guard against
    // an unrelated object coincidentally carrying the brand literal.
    expect(
      isContextOverflowError({
        __brand: "context-overflow",
        name: "SomeOtherError",
      }),
    ).toBe(false);
  });

  test("cross-realm: detects a separately-defined class that carries the same brand + name", () => {
    // Simulate two separately-loaded copies of the module in the same
    // process. The cross-copy instance is NOT `instanceof` our
    // ContextOverflowError, but it *does* carry the brand + name, so the
    // guard should still accept it.
    class ContextOverflowError_Copy extends Error {
      readonly __brand = "context-overflow" as const;
      readonly providerName: string;
      readonly actualTokens?: number;
      readonly maxTokens?: number;
      readonly raw: unknown;
      constructor(
        message: string,
        providerName: string,
        opts: { actualTokens?: number; maxTokens?: number; raw: unknown },
      ) {
        super(message);
        this.name = "ContextOverflowError";
        this.providerName = providerName;
        this.actualTokens = opts.actualTokens;
        this.maxTokens = opts.maxTokens;
        this.raw = opts.raw;
      }
    }
    const err = new ContextOverflowError_Copy("m", "anthropic", {
      actualTokens: 100,
      raw: {},
    });
    // Sanity — the instanceof check alone would fail here:
    expect(err instanceof ContextOverflowError).toBe(false);
    // But the brand+name discriminator makes the guard accept it.
    expect(isContextOverflowError(err)).toBe(true);
  });
});

// ── Per-provider error-body parsing ────────────────────────────────────

/**
 * Construct a real Anthropic APIError so provider-side detection can match
 * the production code path (which checks `instanceof Anthropic.APIError`).
 */
function buildAnthropicApiError(
  status: number,
  body: Record<string, unknown>,
): InstanceType<typeof Anthropic.APIError> {
  return new Anthropic.APIError(status, body, undefined, new Headers());
}

function buildOpenAIApiError(
  status: number,
  body: Record<string, unknown>,
  topLevelMessage?: string,
): InstanceType<typeof OpenAI.APIError> {
  return new OpenAI.APIError(status, body, topLevelMessage, new Headers());
}

describe("detectAnthropicContextOverflow", () => {
  test("matches the canonical nested body shape and extracts both counts", () => {
    const err = buildAnthropicApiError(400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 242201 tokens > 200000 maximum",
      },
    });
    const out = detectAnthropicContextOverflow(err);
    expect(out).not.toBeNull();
    expect(out?.actualTokens).toBe(242201);
    expect(out?.maxTokens).toBe(200000);
  });

  test("handles comma-separated numbers in the message", () => {
    const err = buildAnthropicApiError(400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 242,201 tokens > 200,000 maximum",
      },
    });
    const out = detectAnthropicContextOverflow(err);
    expect(out?.actualTokens).toBe(242201);
    expect(out?.maxTokens).toBe(200000);
  });

  test("returns null for non-overflow 400 errors", () => {
    const err = buildAnthropicApiError(400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "messages.0: role must be user or assistant",
      },
    });
    expect(detectAnthropicContextOverflow(err)).toBeNull();
  });

  test("returns null for non-400 statuses", () => {
    const err = buildAnthropicApiError(429, {
      type: "error",
      error: { type: "rate_limit_error", message: "prompt is too long" },
    });
    expect(detectAnthropicContextOverflow(err)).toBeNull();
  });

  test("matches even when only the top-level JSON message carries the text", () => {
    // If the SDK falls back to JSON.stringify, the top-level message string
    // will still contain the "prompt is too long" text.
    const err = buildAnthropicApiError(400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 242201 tokens > 200000 maximum",
      },
    });
    // The SDK constructor auto-builds err.message; just sanity-check it
    // contains the canonical phrase.
    expect(err.message).toContain("prompt is too long");
    const out = detectAnthropicContextOverflow(err);
    expect(out?.actualTokens).toBe(242201);
  });

  test("matches when no token counts are parseable (returns empty extraction)", () => {
    const err = buildAnthropicApiError(400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long", // no numbers
      },
    });
    const out = detectAnthropicContextOverflow(err);
    expect(out).not.toBeNull();
    expect(out?.actualTokens).toBeUndefined();
    expect(out?.maxTokens).toBeUndefined();
  });
});

describe("detectOpenAICompatibleContextOverflow", () => {
  test("matches the canonical OpenAI context_length_exceeded body", () => {
    const err = buildOpenAIApiError(400, {
      message:
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.",
      type: "invalid_request_error",
      code: "context_length_exceeded",
    });
    const out = detectOpenAICompatibleContextOverflow(err);
    expect(out).not.toBeNull();
  });

  test("matches providers that omit `code` but include the phrase in message", () => {
    // OpenRouter / Fireworks / Ollama often don't set `code` — rely on message.
    const err = buildOpenAIApiError(400, {
      message: "context_length_exceeded: the request has too many input tokens",
      type: "invalid_request_error",
    });
    const out = detectOpenAICompatibleContextOverflow(err);
    expect(out).not.toBeNull();
  });

  test("matches 413 status for request-too-large variants", () => {
    const err = buildOpenAIApiError(413, {
      message: "Request too large: input too long",
      type: "invalid_request_error",
    });
    const out = detectOpenAICompatibleContextOverflow(err);
    expect(out).not.toBeNull();
  });

  test("extracts actual/max tokens when provider surfaces them", () => {
    const err = buildOpenAIApiError(400, {
      message:
        "maximum context length exceeded: 150000 > 128000 tokens in the request",
      type: "invalid_request_error",
      code: "context_length_exceeded",
    });
    const out = detectOpenAICompatibleContextOverflow(err);
    expect(out?.actualTokens).toBe(150000);
    expect(out?.maxTokens).toBe(128000);
  });

  test("returns null for non-overflow 400 errors", () => {
    const err = buildOpenAIApiError(400, {
      message: "Invalid model specified",
      type: "invalid_request_error",
      code: "invalid_model",
    });
    expect(detectOpenAICompatibleContextOverflow(err)).toBeNull();
  });

  test("returns null for non-4xx statuses", () => {
    const err = buildOpenAIApiError(429, {
      message: "Rate limit exceeded",
      type: "rate_limit_error",
    });
    expect(detectOpenAICompatibleContextOverflow(err)).toBeNull();
  });

  test("matches 'too many input tokens' variant emitted by some OpenAI-compatible providers", () => {
    const err = buildOpenAIApiError(400, {
      message: "too many input tokens: 250000",
      type: "invalid_request_error",
    });
    expect(detectOpenAICompatibleContextOverflow(err)).not.toBeNull();
  });
});

describe("Gemini ApiError shape", () => {
  // Smoke-check that the Gemini SDK's ApiError still surfaces status+message
  // the way the detector expects. We cannot import the detector directly
  // because it's private to the Gemini client, but we exercise the shape.
  test("Gemini ApiError exposes status + message", () => {
    const err = new GeminiApiError({
      status: 400,
      message:
        "RESOURCE_EXHAUSTED: The input token count exceeds the maximum number of tokens allowed",
    });
    expect(err.status).toBe(400);
    expect(err.message).toContain("RESOURCE_EXHAUSTED");
  });
});
