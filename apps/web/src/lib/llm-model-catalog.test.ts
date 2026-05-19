import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  MANAGED_MODELS,
  MODELS_BY_PROVIDER,
  providerSupportsPlatformAuth,
  type LlmCatalogModel,
} from "@/lib/llm-model-catalog.js";

function findModel(
  provider: keyof typeof MODELS_BY_PROVIDER,
  id: string,
): LlmCatalogModel | undefined {
  return MODELS_BY_PROVIDER[provider].find(
    (model) => model.id === id,
  ) as LlmCatalogModel | undefined;
}

describe("LLM model catalog", () => {
  test("every provider has its default model present in its model list", () => {
    for (const [provider, models] of Object.entries(MODELS_BY_PROVIDER)) {
      // Providers with per-connection models (e.g. openai-compatible) have an
      // empty static catalog and an empty defaultModel — skip them.
      if (models.length === 0) continue;

      const defaultModel = DEFAULT_MODEL_BY_PROVIDER[
        provider as keyof typeof DEFAULT_MODEL_BY_PROVIDER
      ];

      expect(defaultModel).toBeDefined();
      expect(models.some((model) => model.id === defaultModel)).toBe(true);
    }
  });

  test("managed models are a subset of Anthropic models", () => {
    const anthropicModelIds = new Set(
      MODELS_BY_PROVIDER.anthropic.map((model) => model.id),
    );

    for (const model of MANAGED_MODELS) {
      expect(anthropicModelIds.has(model.id)).toBe(true);
    }
  });

  test("Fireworks supports platform auth", () => {
    expect(providerSupportsPlatformAuth("fireworks")).toBe(true);
  });

  test("model context and output limits are positive integers", () => {
    const models: readonly LlmCatalogModel[] =
      Object.values(MODELS_BY_PROVIDER).flat();

    for (const model of models) {
      expect(Number.isInteger(model.contextWindowTokens)).toBe(true);
      expect(model.contextWindowTokens).toBeGreaterThan(0);
      expect(Number.isInteger(model.defaultContextWindowTokens)).toBe(true);
      expect(model.defaultContextWindowTokens).toBeGreaterThan(0);
      expect(model.defaultContextWindowTokens).toBeLessThanOrEqual(
        model.contextWindowTokens,
      );
      expect(Number.isInteger(model.maxOutputTokens)).toBe(true);
      expect(model.maxOutputTokens).toBeGreaterThan(0);

      if (model.longContextPricingThresholdTokens !== undefined) {
        expect(Number.isInteger(model.longContextPricingThresholdTokens)).toBe(
          true,
        );
        expect(model.longContextPricingThresholdTokens).toBeGreaterThan(0);
        expect(model.longContextPricingThresholdTokens).toBeLessThanOrEqual(
          model.contextWindowTokens,
        );
      }
    }
  });

  test("GPT-5.5 and GPT-5.4 context maxima match researched values", () => {
    expect(findModel("openai", "gpt-5.5")?.contextWindowTokens).toBe(
      1_050_000,
    );
    expect(findModel("openai", "gpt-5.5-pro")?.contextWindowTokens).toBe(
      1_050_000,
    );
    expect(findModel("openai", "gpt-5.4")?.contextWindowTokens).toBe(
      1_050_000,
    );
    expect(findModel("openai", "gpt-5.4-mini")?.contextWindowTokens).toBe(
      400_000,
    );
    expect(findModel("openai", "gpt-5.4-nano")?.contextWindowTokens).toBe(
      400_000,
    );
  });

  test("Sonnet and Opus context maxima match researched values", () => {
    expect(findModel("anthropic", "claude-opus-4-7")?.contextWindowTokens).toBe(
      1_000_000,
    );
    expect(findModel("anthropic", "claude-opus-4-6")?.contextWindowTokens).toBe(
      1_000_000,
    );
    expect(
      findModel("anthropic", "claude-sonnet-4-6")?.contextWindowTokens,
    ).toBe(1_000_000);
    expect(
      findModel("anthropic", "claude-haiku-4-5-20251001")
        ?.contextWindowTokens,
    ).toBe(200_000);
  });

  test("Gemini Pro context maxima match researched values", () => {
    expect(
      findModel("gemini", "gemini-3.1-pro-preview")?.contextWindowTokens,
    ).toBe(1_048_576);
    expect(
      findModel("gemini", "gemini-3.1-pro-preview-customtools")
        ?.contextWindowTokens,
    ).toBe(1_048_576);
    expect(findModel("gemini", "gemini-2.5-pro")?.contextWindowTokens).toBe(
      1_048_576,
    );
  });

  test("Gemini Pro long-context pricing thresholds are exposed to the UI", () => {
    expect(
      findModel("gemini", "gemini-3.1-pro-preview")
        ?.longContextPricingThresholdTokens,
    ).toBe(200_000);
    expect(
      findModel("gemini", "gemini-3.1-pro-preview-customtools")
        ?.longContextPricingThresholdTokens,
    ).toBe(200_000);
    expect(
      findModel("gemini", "gemini-2.5-pro")
        ?.longContextPricingThresholdTokens,
    ).toBe(200_000);
  });
});
