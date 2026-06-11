/**
 * Targeted assertions for the web LLM model catalog: the minimax provider
 * mirrors the daemon catalog, and every provider's default model exists in
 * its models list (the web mirror of the daemon catalog invariant).
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODELS_BY_PROVIDER,
  getModelsForProvider,
  type LlmProviderId,
} from "./llm-model-catalog";

describe("llm-model-catalog", () => {
  test("minimax provider lists MiniMax M3 then MiniMax M2.7", () => {
    expect(getModelsForProvider("minimax").map((model) => model.id)).toEqual([
      "MiniMax-M3",
      "MiniMax-M2.7",
    ]);
  });

  test("every provider's default model exists in its models list", () => {
    for (const [provider, models] of Object.entries(MODELS_BY_PROVIDER)) {
      // openai-compatible is a free-form escape hatch: models are configured
      // per-connection, so it has no catalog entries or default model.
      if (provider === "openai-compatible") continue;
      const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider as LlmProviderId];
      const modelIds: string[] = models.map((model) => model.id);
      expect(modelIds).toContain(defaultModel);
    }
  });
});
