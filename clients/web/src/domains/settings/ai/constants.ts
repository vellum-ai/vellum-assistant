import { VELLUM_SERVED_PROVIDERS } from "@/assistant/llm-model-catalog";

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
  "vercel-ai-gateway",
  "gemini",
  "ollama",
  "minimax",
  "atlascloud",
  "baseten",
] as const;

/**
 * `provider` value stored on the single Vellum-managed connection. It is a
 * routing sentinel, not a real LLM provider, so it never appears in the profile
 * provider picker.
 */
export const VELLUM_CONNECTION_PROVIDER = "vellum";

/**
 * Providers the single Vellum-managed (`vellum`) connection can serve. Mirrors
 * the daemon's managed-routable set. A managed profile keeps its real provider
 * (e.g. `fireworks`) while binding to the provider-agnostic `vellum`
 * connection, so the editor must treat that connection as available for these
 * providers even though its own `provider` is `vellum`.
 */
export const MANAGED_ROUTABLE_PROVIDERS = new Set<string>(
  VELLUM_SERVED_PROVIDERS,
);

export const TOKEN_SLIDER_MIN_TOKENS = 1_000;
export const TOKEN_SLIDER_STEP_TOKENS = 1_000;
export const DEFAULT_CONTEXT_WINDOW_BUDGET_TOKENS = 200_000;
