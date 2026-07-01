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
  "together",
  "openrouter",
  "gemini",
  "ollama",
  "minimax",
  "atlascloud",
] as const;

export const TOKEN_SLIDER_MIN_TOKENS = 1_000;
export const TOKEN_SLIDER_STEP_TOKENS = 1_000;
export const DEFAULT_CONTEXT_WINDOW_BUDGET_TOKENS = 200_000;

/**
 * Default managed profiles that are invariant: they cannot be disabled or
 * relabeled because many internal call sites depend on them always existing
 * with stable identities.
 */
export const INVARIANT_PROFILE_NAMES = new Set([
  "balanced",
  "quality-optimized",
  "cost-optimized",
]);
