/**
 * Pure utility functions for the settings/AI domain.
 *
 * No side effects, no React hooks, no framework imports.
 * Every function here is independently unit-testable.
 */

import type { LlmCatalogModel } from "@/assistant/llm-model-catalog";

import type {
  DaemonConfig,
  InferenceTokenBudgetState,
} from "@/domains/settings/ai/ai-types";
import { TOKEN_SLIDER_MIN_TOKENS } from "@/domains/settings/ai/ai-types";

// ---------------------------------------------------------------------------
// Daemon config parsing
// ---------------------------------------------------------------------------

/**
 * Parse an `unknown` daemon config response into the typed projection.
 * This is the single trust boundary for the freeform config endpoint —
 * every consumer goes through here instead of scattering `as` casts.
 */
export function parseDaemonConfig(data: unknown): DaemonConfig {
  if (!data || typeof data !== "object") return {};
  return data as DaemonConfig;
}

// ---------------------------------------------------------------------------
// Secret provisioning
// ---------------------------------------------------------------------------

export function assertProvisionSuccess(result: unknown): void {
  if (
    result &&
    typeof result === "object" &&
    "success" in result &&
    result.success === false
  ) {
    throw new Error(
      "Failed to provision API key: server returned success=false",
    );
  }
}

// ---------------------------------------------------------------------------
// Token formatting
// ---------------------------------------------------------------------------

function formatCompactNumber(value: number, fractionDigits: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  });
}

export function formatCompactTokens(value: number | number[]): string {
  const numericValue = Array.isArray(value) ? (value[0] ?? 0) : value;
  const roundedValue = Math.round(numericValue);
  if (Math.abs(roundedValue) >= 1_000_000) {
    return `${formatCompactNumber(roundedValue / 1_000_000, 2)}M`;
  }
  if (Math.abs(roundedValue) >= 1_000) {
    return `${formatCompactNumber(roundedValue / 1_000, 1)}K`;
  }
  return roundedValue.toLocaleString("en-US");
}

export function clampTokenBudget(
  value: number,
  max: number,
  min = TOKEN_SLIDER_MIN_TOKENS,
): number {
  if (!Number.isFinite(value)) {
    return Math.min(min, max);
  }
  return Math.min(Math.max(Math.round(value), min), max);
}

export function resolveTokenBudgetStateForModel(
  model: LlmCatalogModel,
  state: InferenceTokenBudgetState,
): InferenceTokenBudgetState {
  const contextBudget = state.contextWindowTouched
    ? state.contextWindowTokens
    : model.defaultContextWindowTokens;
  const maxOutputBudget = state.maxOutputTouched
    ? state.maxOutputTokens
    : model.maxOutputTokens;

  return {
    maxOutputTokens: clampTokenBudget(maxOutputBudget, model.maxOutputTokens),
    maxOutputTouched: state.maxOutputTouched,
    contextWindowTokens: clampTokenBudget(
      contextBudget,
      model.contextWindowTokens,
    ),
    contextWindowTouched: state.contextWindowTouched,
  };
}

export function getLongContextPricingHint(
  model: LlmCatalogModel,
  contextWindowTokens: number,
): string | null {
  const threshold = model.longContextPricingThresholdTokens;
  if (threshold === undefined || contextWindowTokens <= threshold) {
    return null;
  }
  return `Budgets above ${formatCompactTokens(threshold)} may use long-context pricing for ${model.displayName}.`;
}
