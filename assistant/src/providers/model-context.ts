import type { AssistantConfig, ContextWindowConfig } from "../config/types.js";
import { PROVIDER_CATALOG } from "./model-catalog.js";

export const DEFAULT_CONFIGURED_MAX_INPUT_TOKENS = 200_000;

export interface ResolveEffectiveContextWindowTokensInput {
  provider: string;
  model: string;
  configuredMaxInputTokens: number;
}

export function resolveEffectiveContextWindowTokens({
  provider,
  model,
  configuredMaxInputTokens,
}: ResolveEffectiveContextWindowTokensInput): number {
  const providerEntry = PROVIDER_CATALOG.find((entry) => entry.id === provider);
  const catalogModel = providerEntry?.models.find(
    (entry) => entry.id === model,
  );
  const catalogContextWindowTokens = catalogModel?.contextWindowTokens;

  if (
    !Number.isFinite(configuredMaxInputTokens) ||
    configuredMaxInputTokens <= 0
  ) {
    return catalogContextWindowTokens ?? DEFAULT_CONFIGURED_MAX_INPUT_TOKENS;
  }

  if (catalogContextWindowTokens === undefined) {
    return configuredMaxInputTokens;
  }

  return Math.min(catalogContextWindowTokens, configuredMaxInputTokens);
}

export function resolveEffectiveDefaultContextWindowConfig(
  config: AssistantConfig,
): ContextWindowConfig {
  const defaultLlm = config.llm.default;
  const contextWindow = defaultLlm.contextWindow;
  return {
    ...contextWindow,
    maxInputTokens: resolveEffectiveContextWindowTokens({
      provider: defaultLlm.provider,
      model: defaultLlm.model,
      configuredMaxInputTokens: contextWindow.maxInputTokens,
    }),
  };
}
