/**
 * Type aliases derived from generated daemon SDK types.
 *
 * These provide readable names for deeply-nested generated types that are
 * used across the AI settings domain. Types that are already top-level
 * named exports in `types.gen.ts` (e.g. `ServiceMode`, `Auth`,
 * `ConnectionProvider`) should be imported directly from the generated
 * module — not re-derived here.
 *
 * Static catalog data lives in `ai-provider-catalogs.ts`.
 * localStorage keys live in `ai-local-storage-keys.ts`.
 */

import type { ConfigGetResponse, ConfigPatchData, ServiceMode } from "@/generated/daemon/types.gen";

import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";

// Re-export ServiceMode so existing consumers keep working via this module.
export type { ServiceMode } from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Config response type aliases
// ---------------------------------------------------------------------------

/**
 * Full daemon config response from `GET /v1/config`.
 */
export type DaemonConfig = ConfigGetResponse;

/**
 * A single LLM profile entry from the daemon config response.
 * Includes the wire-only `supportsVision` flag resolved at response time.
 */
export type ProfileEntry = NonNullable<
  NonNullable<ConfigGetResponse["llm"]>["profiles"]
>[string];

/**
 * Memory configuration section of the daemon config response.
 */
export type MemoryConfig = NonNullable<ConfigGetResponse["memory"]>;

/**
 * Typed body for daemon config PATCH requests.
 */
export type DaemonConfigPatch = ConfigPatchData["body"];

/**
 * A single profile entry within a PATCH request body.
 * All fields are nullable (null = delete via deep-merge) and optional
 * (omitted = unchanged).
 */
export type ProfilePatchEntry = NonNullable<
  NonNullable<NonNullable<DaemonConfigPatch["llm"]>["profiles"]>[string]
>;

/**
 * A single call-site override within a PATCH request body.
 */
export type CallSiteOverrideDraft = NonNullable<
  NonNullable<NonNullable<DaemonConfigPatch["llm"]>["callSites"]>[string]
>;

// ---------------------------------------------------------------------------
// Derived types
// ---------------------------------------------------------------------------

export type ProfileStatus = NonNullable<ProfileEntry["status"]>;

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
