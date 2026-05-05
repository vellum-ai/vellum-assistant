import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { resolveCallSiteConfig } from "./llm-resolver.js";
import {
  type ContextWindow,
  DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  type LLMCallSite,
  type LLMConfig,
} from "./schemas/llm.js";
import type { ContextWindowConfig } from "./types.js";

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
}: {
  llm: LLMConfig;
  callSite: LLMCallSite;
  overrideProfile?: string;
}): EffectiveContextWindow {
  const resolved = resolveCallSiteConfig(callSite, llm, { overrideProfile });
  const catalogModel = PROVIDER_CATALOG.find(
    (provider) => provider.id === resolved.provider,
  )?.models.find((model) => model.id === resolved.model);

  const modelMaxInputTokens =
    catalogModel?.contextWindowTokens ??
    DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS;
  const defaultInputTokens =
    catalogModel?.defaultContextWindowTokens ??
    DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS;
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
