import { describe, expect, test } from "bun:test";

import type { ModelPricingOverride } from "../config/schema.js";
import type { PricingUsage } from "../usage/types.js";
import {
  resolvePricing,
  resolvePricingForUsage,
  resolvePricingForUsageWithOverrides,
  usesAnthropicPricingRules,
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

describe("fast mode pricing", () => {
  test("applies 6x multiplier when speed is fast", () => {
    const usage: PricingUsage = {
      directInputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      anthropicCacheCreation: null,
      speed: "fast",
    };

    const result = resolvePricingForUsage("anthropic", "claude-opus-4-6", usage);

    // Base: $5 input + $25 output = $30; fast: $30 * 6 = $180
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe((5 + 25) * 6);
  });

  test("does not apply multiplier when speed is standard", () => {
    const usage: PricingUsage = {
      directInputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      anthropicCacheCreation: null,
      speed: "standard",
    };

    const result = resolvePricingForUsage("anthropic", "claude-opus-4-6", usage);

    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(5 + 25);
  });

  test("does not apply multiplier when speed is null", () => {
    const usage: PricingUsage = {
      directInputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      anthropicCacheCreation: null,
      speed: null,
    };

    const result = resolvePricingForUsage("anthropic", "claude-opus-4-6", usage);

    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(5 + 25);
  });

  test("fast mode multiplier stacks with cache pricing", () => {
    const usage: PricingUsage = {
      directInputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      anthropicCacheCreation: {
        ephemeral_5m_input_tokens: 1_000_000,
        ephemeral_1h_input_tokens: 0,
      },
      speed: "fast",
    };

    const standardUsage: PricingUsage = { ...usage, speed: "standard" };

    const fastResult = resolvePricingForUsage(
      "anthropic",
      "claude-opus-4-6",
      usage,
    );
    const standardResult = resolvePricingForUsage(
      "anthropic",
      "claude-opus-4-6",
      standardUsage,
    );

    expect(fastResult.pricingStatus).toBe("priced");
    expect(standardResult.pricingStatus).toBe("priced");
    // Fast mode applies 6x to base rates; cache multipliers stack on top
    expect(fastResult.estimatedCostUsd).toBe(standardResult.estimatedCostUsd! * 6);
  });

  test("does not apply fast mode multiplier for non-Anthropic providers", () => {
    const usage: PricingUsage = {
      directInputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      anthropicCacheCreation: null,
      speed: "fast",
    };

    const result = resolvePricingForUsage("openai", "gpt-4o", usage);

    // Should be standard pricing, not 6x
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(2.5 + 10);
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

describe("Anthropic models on OpenRouter", () => {
  test("prices anthropic/claude-opus-4.6 at Opus 4.6 rates", () => {
    const result = resolvePricing(
      "openrouter",
      "anthropic/claude-opus-4.6",
      1_000_000,
      1_000_000,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(5 + 25);
  });

  test("prices anthropic/claude-sonnet-4.6 at Sonnet 4 rates via prefix match", () => {
    const result = resolvePricing(
      "openrouter",
      "anthropic/claude-sonnet-4.6",
      1_000_000,
      1_000_000,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(3 + 15);
  });

  test("prices anthropic/claude-haiku-4.5 at Haiku 4 rates via prefix match", () => {
    const result = resolvePricing(
      "openrouter",
      "anthropic/claude-haiku-4.5",
      1_000_000,
      1_000_000,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(0.8 + 4);
  });

  test("prices bare claude-opus-4-6 slug returned unprefixed", () => {
    const result = resolvePricing(
      "openrouter",
      "claude-opus-4-6-20260205",
      1_000_000,
      1_000_000,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(5 + 25);
  });

  test("prices dash-form anthropic/claude-opus-4-6 identically to dot form", () => {
    const result = resolvePricing(
      "openrouter",
      "anthropic/claude-opus-4-6",
      1_000_000,
      1_000_000,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(5 + 25);
  });

  test("prices version-first anthropic/claude-4.7-opus-<date> at Opus 4.7 rates", () => {
    // OpenRouter's response.model for Anthropic calls comes back in the form
    // `anthropic/claude-<version>-<family>-<date>`, which previously failed
    // the catalog prefix match (catalog keys are `claude-<family>-<version>`).
    const result = resolvePricing(
      "openrouter",
      "anthropic/claude-4.7-opus-20260416",
      1_000_000,
      1_000_000,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(5 + 25);
  });

  test("prices version-first dash-form anthropic/claude-4-7-opus-<date>", () => {
    const result = resolvePricing(
      "openrouter",
      "anthropic/claude-4-7-opus-20260416",
      1_000_000,
      1_000_000,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(5 + 25);
  });

  test("prices version-first anthropic/claude-4.6-sonnet", () => {
    const result = resolvePricing(
      "openrouter",
      "anthropic/claude-4.6-sonnet",
      1_000_000,
      1_000_000,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(3 + 15);
  });

  test("prices version-first anthropic/claude-4.5-haiku", () => {
    const result = resolvePricing(
      "openrouter",
      "anthropic/claude-4.5-haiku",
      1_000_000,
      1_000_000,
    );
    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe(0.8 + 4);
  });

  test("returns unpriced for unknown anthropic model on OpenRouter", () => {
    const result = resolvePricing(
      "openrouter",
      "anthropic/claude-neptune-99",
      1_000_000,
      1_000_000,
    );
    expect(result.pricingStatus).toBe("unpriced");
    expect(result.estimatedCostUsd).toBeNull();
  });

  test("returns unpriced for non-Anthropic OpenRouter model", () => {
    const result = resolvePricing(
      "openrouter",
      "x-ai/grok-4.20-beta",
      1_000_000,
      1_000_000,
    );
    expect(result.pricingStatus).toBe("unpriced");
    expect(result.estimatedCostUsd).toBeNull();
  });

  test("applies Anthropic cache discounts for prompt-cache reads via OpenRouter", () => {
    const usage: PricingUsage = {
      directInputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1_000_000,
      anthropicCacheCreation: null,
    };
    const openRouter = resolvePricingForUsage(
      "openrouter",
      "anthropic/claude-opus-4.6",
      usage,
    );
    const direct = resolvePricingForUsage("anthropic", "claude-opus-4-6", usage);

    // Cache-read tokens are charged at 10% of input rate for Anthropic models.
    expect(openRouter.pricingStatus).toBe("priced");
    expect(openRouter.estimatedCostUsd).toBeCloseTo(5 * 0.1, 10);
    expect(openRouter.estimatedCostUsd).toBe(direct.estimatedCostUsd);
  });

  test("applies Anthropic cache-write multipliers via OpenRouter", () => {
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
    const openRouter = resolvePricingForUsage(
      "openrouter",
      "anthropic/claude-opus-4.6",
      usage,
    );
    const direct = resolvePricingForUsage(
      "anthropic",
      "claude-opus-4-6",
      usage,
    );

    expect(openRouter.pricingStatus).toBe("priced");
    expect(openRouter.estimatedCostUsd).toBe(direct.estimatedCostUsd);
  });

  test("applies fast-mode multiplier via OpenRouter", () => {
    const usage: PricingUsage = {
      directInputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      anthropicCacheCreation: null,
      speed: "fast",
    };

    const result = resolvePricingForUsage(
      "openrouter",
      "anthropic/claude-opus-4.6",
      usage,
    );

    expect(result.pricingStatus).toBe("priced");
    expect(result.estimatedCostUsd).toBe((5 + 25) * 6);
  });
});

describe("usesAnthropicPricingRules", () => {
  test("returns true for direct Anthropic", () => {
    expect(usesAnthropicPricingRules("anthropic", "claude-opus-4-6")).toBe(true);
  });

  test("returns true for anthropic/* on OpenRouter", () => {
    expect(
      usesAnthropicPricingRules("openrouter", "anthropic/claude-sonnet-4.6"),
    ).toBe(true);
  });

  test("returns true for bare claude-* slug on OpenRouter", () => {
    expect(
      usesAnthropicPricingRules("openrouter", "claude-opus-4-5-20250929"),
    ).toBe(true);
  });

  test("returns false for non-Anthropic OpenRouter models", () => {
    expect(usesAnthropicPricingRules("openrouter", "x-ai/grok-4")).toBe(false);
  });

  test("returns false for other providers", () => {
    expect(usesAnthropicPricingRules("openai", "gpt-4o")).toBe(false);
    expect(usesAnthropicPricingRules("gemini", "gemini-2.5-pro")).toBe(false);
  });
});
