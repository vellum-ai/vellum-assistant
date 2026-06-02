/**
 * Shared types and constants for the settings/AI domain.
 *
 * Consumed by service cards, modals, and the page shell within
 * `domains/settings/ai/`.
 */

import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";

// ---------------------------------------------------------------------------
// Service mode
// ---------------------------------------------------------------------------

export type ServiceMode = "managed" | "your-own";

export function isServiceMode(value: unknown): value is ServiceMode {
  return value === "managed" || value === "your-own";
}

// ---------------------------------------------------------------------------
// Profile types — mirrors the daemon Zod schema in
// `assistant/src/config/schemas/llm.ts`
// ---------------------------------------------------------------------------

export interface ProfileEntry {
  source?: "managed" | "user";
  status?: "active" | "disabled";
  label?: string | null;
  description?: string | null;
  provider?: string | null;
  /**
   * Name of a `provider_connections` row to bind this profile to.
   * Snake_case matches the daemon's Zod schema; do not rename without
   * also touching the daemon route handlers.
   */
  provider_connection?: string | null;
  model?: string | null;
  maxTokens?: number;
  effort?: string;
  speed?: string;
  verbosity?: string;
  temperature?: number | null;
  thinking?: { enabled?: boolean; streamThinking?: boolean; level?: string };
  contextWindow?: { maxInputTokens?: number };
}

// ---------------------------------------------------------------------------
// Daemon config projection — the web app's partial view of the freeform
// `settings.json` returned by GET /v1/assistants/{id}/config.
//
// The endpoint returns `unknown` because the config file evolves
// independently of the web app. This interface projects only the fields
// the settings/AI domain reads. Parse through `parseDaemonConfig()` at
// the single trust boundary rather than scattering `as` casts.
// ---------------------------------------------------------------------------

export interface DaemonConfig {
  services?: {
    "web-search"?: { mode?: string; provider?: string };
    "image-generation"?: { mode?: string };
  };
  llm?: {
    default?: { provider?: string; model?: string };
    activeProfile?: string;
    profileOrder?: string[];
    profiles?: Record<string, ProfileEntry>;
    callSites?: Record<string, CallSiteOverrideDraft | null | undefined>;
  };
}

/** Shape stored per call-site in `config.llm.callSites`. */
export interface CallSiteOverrideDraft {
  profile?: string | null;
  provider?: string | null;
  model?: string | null;
}

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

export interface InferenceTokenBudgetState {
  maxOutputTokens: number;
  maxOutputTouched: boolean;
  contextWindowTokens: number;
  contextWindowTouched: boolean;
}

export const TOKEN_SLIDER_MIN_TOKENS = 1_000;
export const TOKEN_SLIDER_STEP_TOKENS = 1_000;
export const DEFAULT_CONTEXT_WINDOW_BUDGET_TOKENS = 200_000;

// ---------------------------------------------------------------------------
// Inference provider list
// ---------------------------------------------------------------------------

/**
 * Providers that have entries in the LLM model catalog and can be used in
 * call-site overrides. Keep in sync with MODELS_BY_PROVIDER in
 * llm-model-catalog.ts.
 */
export const INFERENCE_PROVIDERS = [
  "anthropic",
  "openai",
  "fireworks",
  "openrouter",
  "gemini",
] as const;

export const INFERENCE_PROVIDER_DISPLAY_NAMES = PROVIDER_DISPLAY_NAMES;


