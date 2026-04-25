/**
 * Provider API key environment variable names, keyed by provider ID.
 *
 * Two sources are merged into a single combined map:
 *
 *   1. Search-provider env vars — hardcoded below (Brave, Perplexity).
 *   2. LLM-provider env vars — sourced from `PROVIDER_CATALOG` in
 *      `assistant/src/providers/model-catalog.ts` via a locally-maintained
 *      mirror (the CLI does not import from `assistant/src/`; drift is caught
 *      by `cli/src/__tests__/llm-provider-env-var-parity.test.ts`).
 *
 * The combined map is what cloud-infra code (docker.ts, aws.ts, gcp.ts)
 * iterates to forward provider API keys from the caller's environment into
 * containers / VMs. Keeping both kinds of provider env vars in one map means
 * the infra call sites don't need to know which kind is which — they just
 * forward every value whose env var is set.
 */

/** LLM provider env var names. Mirrors `PROVIDER_CATALOG` entries with an `envVar`. */
export const LLM_PROVIDER_ENV_VAR_NAMES: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** Search-provider env var names. */
export const SEARCH_PROVIDER_ENV_VAR_NAMES: Record<string, string> = {
  brave: "BRAVE_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

/**
 * Combined provider env var names — the union of LLM and search providers.
 * Used by the cloud-infra flows (docker/aws/gcp) to forward every supported
 * provider API key from the caller's environment.
 */
export const PROVIDER_ENV_VAR_NAMES: Record<string, string> = {
  ...LLM_PROVIDER_ENV_VAR_NAMES,
  ...SEARCH_PROVIDER_ENV_VAR_NAMES,
};
