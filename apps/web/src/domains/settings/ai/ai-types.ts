/**
 * Domain-specific types, constants, and utilities for the AI settings UI.
 *
 * Types that are direct named exports from the generated daemon SDK
 * (`types.gen.ts`) are re-exported here under domain-appropriate aliases
 * so consumers import from one place. Types that don't map to a daemon
 * schema (e.g. `ProfileWithName`, `InferenceTokenBudgetState`) are defined
 * here directly.
 *
 * Static catalog data lives in `ai-provider-catalogs.ts`.
 * localStorage keys live in `ai-local-storage-keys.ts`.
 */

import type { CallSiteOverridePatch, ServiceMode, WireProfileEntry } from "@/generated/daemon/types.gen";

import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";

// ---------------------------------------------------------------------------
// Re-exports from generated daemon SDK
// ---------------------------------------------------------------------------

export type { MemoryConfig, ProfilePatchEntry, ProfileStatus, ServiceMode } from "@/generated/daemon/types.gen";

/**
 * A single LLM profile entry from the daemon config response.
 * Includes the wire-only `supportsVision` flag resolved at response time.
 * Aliased from `WireProfileEntry` — the daemon uses that name internally;
 * the web client just calls it a profile entry.
 */
export type ProfileEntry = WireProfileEntry;

/**
 * A single call-site override within a PATCH request body.
 * Aliased from `CallSiteOverridePatch` — the daemon uses "Patch" naming;
 * the settings UI calls it a "draft" because it represents an in-progress
 * form value before submission.
 */
export type CallSiteOverrideDraft = CallSiteOverridePatch;

// ---------------------------------------------------------------------------
// Domain-specific types
// ---------------------------------------------------------------------------

export type ProfileWithName = { name: string } & ProfileEntry;

export interface InferenceTokenBudgetState {
  maxOutputTokens: number;
  maxOutputTouched: boolean;
  contextWindowTokens: number;
  contextWindowTouched: boolean;
}

// ---------------------------------------------------------------------------
// Inference provider constants
// ---------------------------------------------------------------------------

export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";

/**
 * Providers that have entries in the LLM model catalog and can be used in
 * call-site overrides. Must list exactly the MODELS_BY_PROVIDER keys in
 * llm-model-catalog.ts (minus openai-compatible, whose models are
 * per-connection); parity is enforced by llm-model-catalog.test.ts. Array
 * order is the picker's display order, with index 0 as the default fallback.
 */
export const INFERENCE_PROVIDERS = [
  "anthropic",
  "openai",
  "fireworks",
  "openrouter",
  "gemini",
  "minimax",
] as const;

export const INFERENCE_PROVIDER_DISPLAY_NAMES = PROVIDER_DISPLAY_NAMES;

export const TOKEN_SLIDER_MIN_TOKENS = 1_000;
export const TOKEN_SLIDER_STEP_TOKENS = 1_000;
export const DEFAULT_CONTEXT_WINDOW_BUDGET_TOKENS = 200_000;

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
