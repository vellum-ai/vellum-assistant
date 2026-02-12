import { describe, test, expect } from 'bun:test';
import { estimateCost, resolvePricing, resolvePricingWithOverrides } from '../util/pricing.js';
import type { ModelPricingOverride } from '../config/schema.js';

describe('resolvePricing', () => {
  describe('Anthropic models', () => {
    test('returns priced for claude-opus-4', () => {
      const result = resolvePricing('anthropic', 'claude-opus-4', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(15 + 75);
    });

    test('returns priced for claude-sonnet-4', () => {
      const result = resolvePricing('anthropic', 'claude-sonnet-4', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(3 + 15);
    });

    test('returns priced for claude-haiku-4', () => {
      const result = resolvePricing('anthropic', 'claude-haiku-4', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(0.80 + 4);
    });
  });

  describe('OpenAI models', () => {
    test('returns priced for gpt-4o', () => {
      const result = resolvePricing('openai', 'gpt-4o', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(2.50 + 10);
    });

    test('returns priced for gpt-4o-mini', () => {
      const result = resolvePricing('openai', 'gpt-4o-mini', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(0.15 + 0.60);
    });

    test('returns priced for gpt-4.1', () => {
      const result = resolvePricing('openai', 'gpt-4.1', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(2.00 + 8.00);
    });

    test('returns priced for o3', () => {
      const result = resolvePricing('openai', 'o3', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(2.00 + 8.00);
    });

    test('returns priced for o4-mini', () => {
      const result = resolvePricing('openai', 'o4-mini', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(1.10 + 4.40);
    });
  });

  describe('Gemini models', () => {
    test('returns priced for gemini-2.5-pro', () => {
      const result = resolvePricing('gemini', 'gemini-2.5-pro', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(1.25 + 10);
    });

    test('returns priced for gemini-2.5-flash', () => {
      const result = resolvePricing('gemini', 'gemini-2.5-flash', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(0.15 + 0.60);
    });

    test('returns priced for gemini-2.0-flash', () => {
      const result = resolvePricing('gemini', 'gemini-2.0-flash', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(0.10 + 0.40);
    });
  });

  describe('unknown models', () => {
    test('returns unpriced with null cost for unknown model', () => {
      const result = resolvePricing('anthropic', 'unknown-model-xyz', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('unpriced');
      expect(result.estimatedCostUsd).toBeNull();
    });

    test('returns unpriced for unknown provider', () => {
      const result = resolvePricing('unknown-provider', 'some-model', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('unpriced');
      expect(result.estimatedCostUsd).toBeNull();
    });
  });

  describe('Ollama (local) models', () => {
    test('returns unpriced for ollama models', () => {
      const result = resolvePricing('ollama', 'llama3:latest', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('unpriced');
      expect(result.estimatedCostUsd).toBeNull();
    });

    test('returns unpriced for ollama with any model name', () => {
      const result = resolvePricing('ollama', 'mistral:7b', 500_000, 500_000);
      expect(result.pricingStatus).toBe('unpriced');
      expect(result.estimatedCostUsd).toBeNull();
    });
  });

  describe('prefix matching', () => {
    test('matches claude-sonnet-4-5-20250929 via claude-sonnet-4 prefix', () => {
      const result = resolvePricing('anthropic', 'claude-sonnet-4-5-20250929', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(3 + 15);
    });

    test('matches claude-opus-4-5-20250929 via claude-opus-4 prefix', () => {
      const result = resolvePricing('anthropic', 'claude-opus-4-5-20250929', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(15 + 75);
    });

    test('matches gpt-4o-mini-2024-07-18 via gpt-4o-mini prefix', () => {
      const result = resolvePricing('openai', 'gpt-4o-mini-2024-07-18', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(0.15 + 0.60);
    });

    test('matches gemini-2.5-pro-preview via gemini-2.5-pro prefix', () => {
      const result = resolvePricing('gemini', 'gemini-2.5-pro-preview', 1_000_000, 1_000_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(1.25 + 10);
    });
  });

  describe('cost calculation', () => {
    test('calculates correctly with fractional token counts', () => {
      // 500k input, 200k output with claude-sonnet-4 pricing (3/15 per 1M)
      const result = resolvePricing('anthropic', 'claude-sonnet-4', 500_000, 200_000);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBeCloseTo(0.5 * 3 + 0.2 * 15, 10);
    });

    test('returns 0 cost for zero tokens', () => {
      const result = resolvePricing('anthropic', 'claude-sonnet-4', 0, 0);
      expect(result.pricingStatus).toBe('priced');
      expect(result.estimatedCostUsd).toBe(0);
    });
  });
});

describe('resolvePricingWithOverrides', () => {
  test('uses override when matching provider and modelPattern', () => {
    const overrides: ModelPricingOverride[] = [
      { provider: 'anthropic', modelPattern: 'claude-sonnet-4', inputPer1M: 5, outputPer1M: 25 },
    ];
    const result = resolvePricingWithOverrides('anthropic', 'claude-sonnet-4', 1_000_000, 1_000_000, overrides);
    expect(result.pricingStatus).toBe('priced');
    expect(result.estimatedCostUsd).toBe(5 + 25);
  });

  test('override prefix matching works with version suffixes', () => {
    const overrides: ModelPricingOverride[] = [
      { provider: 'anthropic', modelPattern: 'claude-sonnet-4', inputPer1M: 5, outputPer1M: 25 },
    ];
    const result = resolvePricingWithOverrides('anthropic', 'claude-sonnet-4-5-20250929', 1_000_000, 1_000_000, overrides);
    expect(result.pricingStatus).toBe('priced');
    expect(result.estimatedCostUsd).toBe(5 + 25);
  });

  test('falls back to built-in catalog when no override matches', () => {
    const overrides: ModelPricingOverride[] = [
      { provider: 'openai', modelPattern: 'gpt-4o', inputPer1M: 99, outputPer1M: 99 },
    ];
    // Different provider, so override should not match
    const result = resolvePricingWithOverrides('anthropic', 'claude-sonnet-4', 1_000_000, 1_000_000, overrides);
    expect(result.pricingStatus).toBe('priced');
    expect(result.estimatedCostUsd).toBe(3 + 15);
  });

  test('falls back to built-in catalog with empty overrides array', () => {
    const result = resolvePricingWithOverrides('anthropic', 'claude-sonnet-4', 1_000_000, 1_000_000, []);
    expect(result.pricingStatus).toBe('priced');
    expect(result.estimatedCostUsd).toBe(3 + 15);
  });

  test('falls back to built-in catalog with no overrides argument', () => {
    const result = resolvePricingWithOverrides('anthropic', 'claude-sonnet-4', 1_000_000, 1_000_000);
    expect(result.pricingStatus).toBe('priced');
    expect(result.estimatedCostUsd).toBe(3 + 15);
  });

  test('override can price a previously unpriced provider/model', () => {
    const overrides: ModelPricingOverride[] = [
      { provider: 'ollama', modelPattern: 'llama3', inputPer1M: 0, outputPer1M: 0 },
    ];
    const result = resolvePricingWithOverrides('ollama', 'llama3:latest', 1_000_000, 1_000_000, overrides);
    expect(result.pricingStatus).toBe('priced');
    expect(result.estimatedCostUsd).toBe(0);
  });

  test('longest modelPattern prefix wins among overrides', () => {
    const overrides: ModelPricingOverride[] = [
      { provider: 'anthropic', modelPattern: 'claude-sonnet', inputPer1M: 1, outputPer1M: 1 },
      { provider: 'anthropic', modelPattern: 'claude-sonnet-4', inputPer1M: 99, outputPer1M: 99 },
    ];
    const result = resolvePricingWithOverrides('anthropic', 'claude-sonnet-4-5-20250929', 1_000_000, 1_000_000, overrides);
    expect(result.pricingStatus).toBe('priced');
    expect(result.estimatedCostUsd).toBe(99 + 99);
  });
});

describe('estimateCost (backward compatibility)', () => {
  test('returns a number for known Claude model', () => {
    const cost = estimateCost(1_000_000, 1_000_000, 'claude-sonnet-4-5-20250929');
    expect(typeof cost).toBe('number');
    expect(cost).toBe(3 + 15);
  });

  test('returns 0 for unknown model', () => {
    const cost = estimateCost(1_000_000, 1_000_000, 'unknown-model');
    expect(cost).toBe(0);
  });

  test('returns correct cost for claude-opus-4 via prefix match', () => {
    const cost = estimateCost(1_000_000, 1_000_000, 'claude-opus-4-5-20250929');
    expect(cost).toBe(15 + 75);
  });

  test('returns correct cost for claude-haiku-4 via prefix match', () => {
    const cost = estimateCost(1_000_000, 1_000_000, 'claude-haiku-4-5-20251001');
    expect(cost).toBe(0.80 + 4);
  });

  test('always returns number type, never null', () => {
    const cost = estimateCost(500_000, 500_000, 'nonexistent-model');
    expect(typeof cost).toBe('number');
    expect(cost).toBe(0);
  });
});
