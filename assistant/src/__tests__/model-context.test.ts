import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CONFIGURED_MAX_INPUT_TOKENS,
  resolveEffectiveContextWindowTokens,
} from "../providers/model-context.js";

describe("model context", () => {
  test("uses the catalog context window when it is smaller than config", () => {
    expect(
      resolveEffectiveContextWindowTokens({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        configuredMaxInputTokens: 300_000,
      }),
    ).toBe(200_000);
  });

  test("uses configured max input tokens when smaller than the catalog", () => {
    expect(
      resolveEffectiveContextWindowTokens({
        provider: "openai",
        model: "gpt-5.4",
        configuredMaxInputTokens: 100_000,
      }),
    ).toBe(100_000);
  });

  test("falls back to configured max input tokens for unknown models", () => {
    expect(
      resolveEffectiveContextWindowTokens({
        provider: "anthropic",
        model: "custom-model",
        configuredMaxInputTokens: 123_456,
      }),
    ).toBe(123_456);
  });

  test("falls back to configured max input tokens for unknown providers", () => {
    expect(
      resolveEffectiveContextWindowTokens({
        provider: "provider-proxy",
        model: "custom-model",
        configuredMaxInputTokens: 123_456,
      }),
    ).toBe(123_456);
  });

  test("uses catalog context window when configured max input tokens is invalid", () => {
    expect(
      resolveEffectiveContextWindowTokens({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        configuredMaxInputTokens: 0,
      }),
    ).toBe(200_000);
  });

  test("uses the config fallback for unknown models with invalid max input tokens", () => {
    expect(
      resolveEffectiveContextWindowTokens({
        provider: "provider-proxy",
        model: "custom-model",
        configuredMaxInputTokens: Number.NaN,
      }),
    ).toBe(DEFAULT_CONFIGURED_MAX_INPUT_TOKENS);
  });
});
