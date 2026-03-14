import { describe, expect, test } from "bun:test";

import type { ModelPricingOverride } from "../config/schema.js";
import type { PricingUsage } from "../usage/types.js";
import {
  estimateCost,
  resolvePricing,
  resolvePricingForUsage,
  resolvePricingForUsageWithOverrides,
  resolvePricingWithOverrides,
} from "../util/pricing.js";

describe("resolvePricing", () => {
  describe("Anthropic models", () => {
    test("returns priced for claude-opus-4-6", () => {
      const result = resolvePricing(
        "anthropic",
        "claude-opus-4-6",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(5 + 25);
    });

    test("returns priced for claude-opus-4", () => {
      const result = resolvePricing(
        "anthropic",
        "claude-opus-4",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(15 + 75);
    });

    test("returns priced for claude-sonnet-4", () => {
      const result = resolvePricing(
        "anthropic",
        "claude-sonnet-4",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(3 + 15);
    });

    test("returns priced for claude-haiku-4", () => {
      const result = resolvePricing(
        "anthropic",
        "claude-haiku-4",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(0.8 + 4);
    });
  });

  describe("OpenAI models", () => {
    test("returns priced for gpt-4o", () => {
      const result = resolvePricing("openai", "gpt-4o", 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(2.5 + 10);
    });

    test("returns priced for gpt-4o-mini", () => {
      const result = resolvePricing(
        "openai",
        "gpt-4o-mini",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(0.15 + 0.6);
    });

    test("returns priced for gpt-4.1", () => {
      const result = resolvePricing("openai", "gpt-4.1", 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(2.0 + 8.0);
    });

    test("returns priced for o3", () => {
      const result = resolvePricing("openai", "o3", 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(2.0 + 8.0);
    });

    test("returns priced for o4-mini", () => {
      const result = resolvePricing("openai", "o4-mini", 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(1.1 + 4.4);
    });
  });

  describe("Gemini models", () => {
    test("returns priced for gemini-2.5-pro", () => {
      const result = resolvePricing(
        "gemini",
        "gemini-2.5-pro",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(1.25 + 10);
    });

    test("returns priced for gemini-2.5-flash", () => {
      const result = resolvePricing(
        "gemini",
        "gemini-2.5-flash",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(0.15 + 0.6);
    });

    test("returns priced for gemini-2.0-flash", () => {
      const result = resolvePricing(
        "gemini",
        "gemini-2.0-flash",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(0.1 + 0.4);
    });
  });

  describe("unknown models", () => {
    test("returns unpriced with null cost for unknown model", () => {
      const result = resolvePricing(
        "anthropic",
        "unknown-model-xyz",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("unpriced");
      expect(result.estimatedCostUsd).toBeNull();
    });

    test("returns unpriced for unknown provider", () => {
      const result = resolvePricing(
        "unknown-provider",
        "some-model",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("unpriced");
      expect(result.estimatedCostUsd).toBeNull();
    });
  });

  describe("Ollama (local) models", () => {
    test("returns unpriced for ollama models", () => {
      const result = resolvePricing(
        "ollama",
        "llama3:latest",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("unpriced");
      expect(result.estimatedCostUsd).toBeNull();
    });

    test("returns unpriced for ollama with any model name", () => {
      const result = resolvePricing("ollama", "mistral:7b", 500_000, 500_000);
      expect(result.pricingStatus).toBe("unpriced");
      expect(result.estimatedCostUsd).toBeNull();
    });
  });

  describe("prefix matching", () => {
    test("matches claude-opus-4-6-20260205 via claude-opus-4-6 prefix", () => {
      const result = resolvePricing(
        "anthropic",
        "claude-opus-4-6-20260205",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(5 + 25);
    });

    test("matches claude-sonnet-4-6 via claude-sonnet-4 prefix", () => {
      const result = resolvePricing(
        "anthropic",
        "claude-sonnet-4-6",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(3 + 15);
    });

    test("matches claude-opus-4-5-20250929 via claude-opus-4 prefix", () => {
      const result = resolvePricing(
        "anthropic",
        "claude-opus-4-5-20250929",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(15 + 75);
    });

    test("matches gpt-4o-mini-2024-07-18 via gpt-4o-mini prefix", () => {
      const result = resolvePricing(
        "openai",
        "gpt-4o-mini-2024-07-18",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(0.15 + 0.6);
    });

    test("matches gemini-2.5-pro-preview via gemini-2.5-pro prefix", () => {
      const result = resolvePricing(
        "gemini",
        "gemini-2.5-pro-preview",
        1_000_000,
        1_000_000,
      );
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(1.25 + 10);
    });
  });

  describe("cost calculation", () => {
    test("calculates correctly with fractional token counts", () => {
      // 500k input, 200k output with claude-sonnet-4 pricing (3/15 per 1M)
      const result = resolvePricing(
        "anthropic",
        "claude-sonnet-4",
        500_000,
        200_000,
      );
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBeCloseTo(0.5 * 3 + 0.2 * 15, 10);
    });

    test("returns 0 cost for zero tokens", () => {
      const result = resolvePricing("anthropic", "claude-sonnet-4", 0, 0);
      expect(result.pricingStatus).toBe("priced");
      expect(result.estimatedCostUsd).toBe(0);
    });
  });
});

describe("resolvePricingForUsage", () => {
  test("prices mixed direct, cache read, and cache write Anthropic usage", () => {
    const usage: PricingUsage = {
      directInputTokens: 1_000_000,
      outputTokens: 2_000_000,
      cacheCreationInputTokens: 300_000,
      cacheReadInputTokens: 300_000,
      anthropicCacheCreation: {
        ephemeral_5m_input_tokens: 200_000,
        ephemeral_1h_input_tokens: 100_000,
      },
    };

    const result = resolvePricingForUsage(
      "anthropic",
      "claude-opus-4-6",
      usage,
    );

    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBeCloseTo(57.4, 10);
  });

  test("returns unpriced with null cost for unknown provider", () => {
    const usage: PricingUsage = {
      directInputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 40,
      anthropicCacheCreation: {
        ephemeral_5m_input_tokens: 10,
        ephemeral_1h_input_tokens: 20,
      },
    };

    const result = resolvePricingForUsage(
      "unknown-provider",
      "some-model",
      usage,
    );

    expect(result.pricingStatus).toBe("unpriced");
    expect(result.estimatedCostUsd).toBeNull();
  });
});

describe("resolvePricingWithOverrides", () => {
  test("uses override when matching provider and modelPattern", () => {
    const overrides: ModelPricingOverride[] = [
      {
        provider: "anthropic",
        modelPattern: "claude-sonnet-4",
        inputPer1M: 5,
        outputPer1M: 25,
      },
    ];
    const result = resolvePricingWithOverrides(
      "anthropic",
      "claude-sonnet-4",
      1_000_000,
      1_000_000,
      overrides,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(5 + 25);
  });

  test("override prefix matching works with version suffixes", () => {
    const overrides: ModelPricingOverride[] = [
      {
        provider: "anthropic",
        modelPattern: "claude-sonnet-4",
        inputPer1M: 5,
        outputPer1M: 25,
      },
    ];
    const result = resolvePricingWithOverrides(
      "anthropic",
      "claude-sonnet-4-6",
      1_000_000,
      1_000_000,
      overrides,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(5 + 25);
  });

  test("falls back to built-in catalog when no override matches", () => {
    const overrides: ModelPricingOverride[] = [
      {
        provider: "openai",
        modelPattern: "gpt-4o",
        inputPer1M: 99,
        outputPer1M: 99,
      },
    ];
    // Different provider, so override should not match
    const result = resolvePricingWithOverrides(
      "anthropic",
      "claude-sonnet-4",
      1_000_000,
      1_000_000,
      overrides,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(3 + 15);
  });

  test("falls back to built-in catalog with empty overrides array", () => {
    const result = resolvePricingWithOverrides(
      "anthropic",
      "claude-sonnet-4",
      1_000_000,
      1_000_000,
      [],
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(3 + 15);
  });

  test("falls back to built-in catalog with no overrides argument", () => {
    const result = resolvePricingWithOverrides(
      "anthropic",
      "claude-sonnet-4",
      1_000_000,
      1_000_000,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(3 + 15);
  });

  test("override can price a previously unpriced provider/model", () => {
    const overrides: ModelPricingOverride[] = [
      {
        provider: "ollama",
        modelPattern: "llama3",
        inputPer1M: 0,
        outputPer1M: 0,
      },
    ];
    const result = resolvePricingWithOverrides(
      "ollama",
      "llama3:latest",
      1_000_000,
      1_000_000,
      overrides,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(0);
  });

  test("longest modelPattern prefix wins among overrides", () => {
    const overrides: ModelPricingOverride[] = [
      {
        provider: "anthropic",
        modelPattern: "claude-sonnet",
        inputPer1M: 1,
        outputPer1M: 1,
      },
      {
        provider: "anthropic",
        modelPattern: "claude-sonnet-4",
        inputPer1M: 99,
        outputPer1M: 99,
      },
    ];
    const result = resolvePricingWithOverrides(
      "anthropic",
      "claude-sonnet-4-6",
      1_000_000,
      1_000_000,
      overrides,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(99 + 99);
  });
});

describe("resolvePricingForUsageWithOverrides", () => {
  test("uses override pricing for structured Anthropic usage", () => {
    const usage: PricingUsage = {
      directInputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 200_000,
      cacheReadInputTokens: 100_000,
      anthropicCacheCreation: {
        ephemeral_5m_input_tokens: 200_000,
        ephemeral_1h_input_tokens: 0,
      },
    };
    const overrides: ModelPricingOverride[] = [
      {
        provider: "anthropic",
        modelPattern: "claude-opus-4-6",
        inputPer1M: 10,
        outputPer1M: 20,
      },
    ];

    const result = resolvePricingForUsageWithOverrides(
      "anthropic",
      "claude-opus-4-6",
      usage,
      overrides,
    );

    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBeCloseTo(32.6, 10);
  });
});

describe("estimateCost", () => {
  test("returns a number for known Anthropic model", () => {
    const cost = estimateCost(
      1_000_000,
      1_000_000,
      "claude-sonnet-4-6",
      "anthropic",
    );
    expect(typeof cost).toBe("number");
    expect(cost).toBe(3 + 15);
  });

  test("returns correct cost for standard claude-opus-4-6", () => {
    const cost = estimateCost(
      1_000_000,
      1_000_000,
      "claude-opus-4-6",
      "anthropic",
    );
    expect(cost).toBe(5 + 25);
  });

  test("returns 0 for unknown model", () => {
    const cost = estimateCost(
      1_000_000,
      1_000_000,
      "unknown-model",
      "anthropic",
    );
    expect(cost).toBe(0);
  });

  test("returns correct cost for claude-opus-4 via prefix match", () => {
    const cost = estimateCost(
      1_000_000,
      1_000_000,
      "claude-opus-4-5-20250929",
      "anthropic",
    );
    expect(cost).toBe(15 + 75);
  });

  test("returns correct cost for claude-haiku-4 via prefix match", () => {
    const cost = estimateCost(
      1_000_000,
      1_000_000,
      "claude-haiku-4-5-20251001",
      "anthropic",
    );
    expect(cost).toBe(0.8 + 4);
  });

  test("always returns number type, never null", () => {
    const cost = estimateCost(
      500_000,
      500_000,
      "nonexistent-model",
      "anthropic",
    );
    expect(typeof cost).toBe("number");
    expect(cost).toBe(0);
  });

  test("returns correct cost for OpenAI gpt-4o", () => {
    const cost = estimateCost(1_000_000, 1_000_000, "gpt-4o", "openai");
    expect(cost).toBe(2.5 + 10);
  });

  test("returns correct cost for Gemini model", () => {
    const cost = estimateCost(1_000_000, 1_000_000, "gemini-2.5-pro", "gemini");
    expect(cost).toBe(1.25 + 10);
  });

  test("returns 0 for Ollama (local) provider", () => {
    const cost = estimateCost(1_000_000, 1_000_000, "llama3:latest", "ollama");
    expect(cost).toBe(0);
  });

  test("returns 0 for unknown provider", () => {
    const cost = estimateCost(
      1_000_000,
      1_000_000,
      "some-model",
      "unknown-provider",
    );
    expect(cost).toBe(0);
  });
});
