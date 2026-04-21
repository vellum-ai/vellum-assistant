import { describe, expect, test } from "bun:test";

import {
  getModelCapabilities,
  isModelInCatalog,
  PROVIDER_CATALOG,
} from "../model-catalog.js";

describe("getModelCapabilities", () => {
  test("returns non-null capabilities for an Anthropic Claude model", () => {
    const capabilities = getModelCapabilities("anthropic", "claude-opus-4-7");
    expect(capabilities).not.toBeNull();
    expect(capabilities?.contextWindow).toBe(200_000);
    expect(capabilities?.supportsPromptCaching).toBe(true);
    expect(capabilities?.maxOutputTokens).toBe(32_768);
  });

  test("returns non-null capabilities for a Gemini model with 1M context window", () => {
    const capabilities = getModelCapabilities("gemini", "gemini-3-flash");
    expect(capabilities).not.toBeNull();
    expect(capabilities?.contextWindow).toBe(1_048_576);
    expect(capabilities?.supportsPromptCaching).toBe(true);
  });

  test("flags self-hosted Ollama models as lacking prompt caching", () => {
    const capabilities = getModelCapabilities("ollama", "llama3.2");
    expect(capabilities).not.toBeNull();
    expect(capabilities?.supportsPromptCaching).toBe(false);
    expect(capabilities?.inputCostPer1M).toBeUndefined();
    expect(capabilities?.outputCostPer1M).toBeUndefined();
  });

  test("returns null for an unknown provider", () => {
    const capabilities = getModelCapabilities("bogus", "nope");
    expect(capabilities).toBeNull();
  });

  test("returns null for a known provider with an unknown model ID", () => {
    const capabilities = getModelCapabilities("anthropic", "not-a-real-model");
    expect(capabilities).toBeNull();
  });

  test("matches provider name case-insensitively", () => {
    const lower = getModelCapabilities("anthropic", "claude-opus-4-7");
    const mixed = getModelCapabilities("Anthropic", "claude-opus-4-7");
    const upper = getModelCapabilities("ANTHROPIC", "claude-opus-4-7");
    expect(lower).not.toBeNull();
    expect(mixed).not.toBeNull();
    expect(upper).not.toBeNull();
    expect(mixed?.id).toBe(lower!.id);
    expect(upper?.id).toBe(lower!.id);
  });

  test("uses exact match on model ID (case-sensitive)", () => {
    const exact = getModelCapabilities("anthropic", "claude-opus-4-7");
    const upper = getModelCapabilities("anthropic", "CLAUDE-OPUS-4-7");
    expect(exact).not.toBeNull();
    // Vendor model IDs are canonical — we don't silently coerce case.
    expect(upper).toBeNull();
  });

  test("exposes pricing fields on Anthropic models including cache rates", () => {
    const capabilities = getModelCapabilities("anthropic", "claude-sonnet-4-6");
    expect(capabilities).not.toBeNull();
    expect(capabilities?.inputCostPer1M).toBe(3);
    expect(capabilities?.outputCostPer1M).toBe(15);
    // Anthropic cache relationships: read = 0.1x, 5m write = 1.25x, 1h write = 2x.
    expect(capabilities?.cacheReadCostPer1M).toBeCloseTo(0.3, 5);
    expect(capabilities?.cacheWrite5mCostPer1M).toBeCloseTo(3.75, 5);
    expect(capabilities?.cacheWrite1hCostPer1M).toBeCloseTo(6, 5);
  });

  test("Haiku 4.5 uses the expected low-tier pricing", () => {
    const capabilities = getModelCapabilities(
      "anthropic",
      "claude-haiku-4-5-20251001",
    );
    expect(capabilities).not.toBeNull();
    expect(capabilities?.inputCostPer1M).toBe(1);
    expect(capabilities?.outputCostPer1M).toBe(5);
    expect(capabilities?.maxOutputTokens).toBe(8_192);
  });

  test("OpenRouter Anthropic aliases mirror upstream Anthropic context windows", () => {
    const opus = getModelCapabilities(
      "openrouter",
      "anthropic/claude-opus-4.7",
    );
    expect(opus).not.toBeNull();
    expect(opus?.contextWindow).toBe(200_000);
    expect(opus?.supportsPromptCaching).toBe(true);
  });
});

describe("PROVIDER_CATALOG seed completeness", () => {
  test("every model in the catalog has a non-zero contextWindow and maxOutputTokens", () => {
    for (const provider of PROVIDER_CATALOG) {
      for (const model of provider.models) {
        expect(
          model.contextWindow,
          `${provider.id}/${model.id} missing contextWindow`,
        ).toBeGreaterThan(0);
        expect(
          model.maxOutputTokens,
          `${provider.id}/${model.id} missing maxOutputTokens`,
        ).toBeGreaterThan(0);
        expect(
          typeof model.supportsPromptCaching,
          `${provider.id}/${model.id} missing supportsPromptCaching`,
        ).toBe("boolean");
      }
    }
  });

  test("every listed defaultModel is present in the provider's models list", () => {
    for (const provider of PROVIDER_CATALOG) {
      expect(
        isModelInCatalog(provider.id, provider.defaultModel),
        `${provider.id}.defaultModel "${provider.defaultModel}" not in models list`,
      ).toBe(true);
    }
  });
});
