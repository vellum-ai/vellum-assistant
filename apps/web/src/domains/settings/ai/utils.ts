import type { LlmCatalogModel } from "@/assistant/llm-model-catalog";
import {
  WEB_SEARCH_PROVIDER_KEY_STORAGE,
} from "@/assistant/generated/web-search-provider-catalog.gen";
import type { ProfileEntry, ServiceMode } from "@/generated/daemon/types.gen";

import { TOKEN_SLIDER_MIN_TOKENS } from "@/domains/settings/ai/constants";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type ProfileWithName = { name: string } & ProfileEntry;

export interface InferenceTokenBudgetState {
  maxOutputTokens: number;
  maxOutputTouched: boolean;
  contextWindowTokens: number;
  contextWindowTouched: boolean;
}

// ---------------------------------------------------------------------------
// Service mode validation
// ---------------------------------------------------------------------------

const SERVICE_MODE_VALUES: ReadonlySet<string> = new Set<ServiceMode>(["managed", "your-own"]);

/**
 * Validates a raw string (e.g. from localStorage) as a `ServiceMode`.
 * Returns `fallback` when the value is not a known mode.
 */
export function parseServiceMode(raw: string, fallback: ServiceMode): ServiceMode {
  return SERVICE_MODE_VALUES.has(raw) ? (raw as ServiceMode) : fallback;
}

// ---------------------------------------------------------------------------
// Profile utilities
// ---------------------------------------------------------------------------

/**
 * Merges `profileOrder` with `profiles` to produce a stable ordered list.
 *
 * Entries appear in `profileOrder` sequence first, followed by any extras
 * present in `profiles` but missing from `profileOrder` (e.g. newly seeded
 * profiles that haven't been reordered yet).
 */
export function buildOrderedProfiles(
  profiles: Record<string, ProfileEntry>,
  profileOrder: string[],
): ProfileWithName[] {
  const ordered = profileOrder
    .filter((name) => name in profiles)
    .map((name) => ({ name, ...profiles[name]! }));
  const inOrder = new Set(profileOrder);
  const extras = Object.entries(profiles)
    .filter(([name]) => !inOrder.has(name))
    .map(([name, entry]) => ({ name, ...entry }));
  return [...ordered, ...extras];
}

export function assertProvisionSuccess(result: unknown): void {
  if (
    result &&
    typeof result === "object" &&
    "success" in result &&
    result.success === false
  ) {
    throw new Error("Failed to provision API key: server returned success=false");
  }
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
    maxOutputTokens: clampTokenBudget(
      maxOutputBudget,
      model.maxOutputTokens,
    ),
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

/**
 * Returns the localStorage key for a web-search provider's user-supplied
 * API key, or "" for managed providers that don't store a user-supplied key.
 */
export function getWebSearchProviderKeyStorage(provider: string): string {
  return WEB_SEARCH_PROVIDER_KEY_STORAGE[provider] ?? "";
}
