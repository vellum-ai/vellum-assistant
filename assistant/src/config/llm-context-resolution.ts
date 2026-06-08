import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { resolveCallSiteConfig } from "./llm-resolver.js";
import {
  type ContextWindow,
  DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  type LLMCallSite,
  type LLMConfig,
  type ModelContextLimit,
} from "./schemas/llm.js";
import type { ContextWindowConfig } from "./types.js";

/**
 * Resolve a configured context-window ceiling override for a provider/model.
 * Matches on exact provider and the longest `modelPattern` prefix, mirroring
 * the pricing-override resolution in `util/pricing.ts`.
 */
function findModelContextLimit(
  overrides: ModelContextLimit[] | undefined,
  provider: string,
  model: string,
): number | undefined {
  if (!overrides || overrides.length === 0) return undefined;

  let bestTokens: number | undefined;
  let bestLen = -1;
  for (const override of overrides) {
    if (override.provider !== provider) continue;
    if (
      model !== override.modelPattern &&
      !model.startsWith(override.modelPattern)
    ) {
      continue;
    }
    if (override.modelPattern.length > bestLen) {
      bestTokens = override.contextWindowTokens;
      bestLen = override.modelPattern.length;
    }
  }
  return bestTokens;
}

export interface EffectiveContextWindow {
  provider: string;
  model: string;
  enabled: boolean;
  maxInputTokens: number;
  modelMaxInputTokens: number;
  defaultInputTokens: number;
  compactThreshold: number;
  summaryBudgetRatio: number;
  targetBudgetRatio: number;
  overflowRecovery: ContextWindow["overflowRecovery"];
  isLongContextEnabled: boolean;
  maxOutputTokens?: number;
}

export function resolveEffectiveContextWindow({
  llm,
  callSite,
  overrideProfile,
  selectionSeed,
}: {
  llm: LLMConfig;
  callSite: LLMCallSite;
  overrideProfile?: string;
  /**
   * Per-conversation mix seed (the conversation id). Threaded so context-window
   * sizing for a mix profile reflects the same arm the dispatch path picks.
   */
  selectionSeed?: string;
}): EffectiveContextWindow {
  const resolved = resolveCallSiteConfig(callSite, llm, {
    overrideProfile,
    selectionSeed,
  });
  const catalogModel = PROVIDER_CATALOG.find(
    (provider) => provider.id === resolved.provider,
  )?.models.find((model) => model.id === resolved.model);

  const overrideTokens = findModelContextLimit(
    llm.modelContextLimits,
    resolved.provider,
    resolved.model,
  );
  const modelMaxInputTokens =
    overrideTokens ??
    catalogModel?.contextWindowTokens ??
    DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS;
  // Keep the long-context threshold at or below the (possibly overridden)
  // ceiling, matching how the catalog derives `defaultContextWindowTokens`.
  const defaultInputTokens = Math.min(
    catalogModel?.defaultContextWindowTokens ??
      DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
    modelMaxInputTokens,
  );
  const maxInputTokens = Math.min(
    resolved.contextWindow.maxInputTokens,
    modelMaxInputTokens,
  );

  return {
    provider: resolved.provider,
    model: resolved.model,
    enabled: resolved.contextWindow.enabled,
    maxInputTokens,
    modelMaxInputTokens,
    defaultInputTokens,
    compactThreshold: resolved.contextWindow.compactThreshold,
    summaryBudgetRatio: resolved.contextWindow.summaryBudgetRatio,
    targetBudgetRatio: resolved.contextWindow.targetBudgetRatio,
    overflowRecovery: resolved.contextWindow.overflowRecovery,
    isLongContextEnabled: maxInputTokens > defaultInputTokens,
    maxOutputTokens: catalogModel?.maxOutputTokens,
  };
}

export function contextWindowConfigFromEffective(
  base: ContextWindowConfig,
  effective: EffectiveContextWindow,
): ContextWindowConfig {
  return {
    ...base,
    enabled: effective.enabled,
    maxInputTokens: effective.maxInputTokens,
    targetBudgetRatio: effective.targetBudgetRatio,
    compactThreshold: effective.compactThreshold,
    summaryBudgetRatio: effective.summaryBudgetRatio,
    overflowRecovery: effective.overflowRecovery,
  };
}
