/**
 * Provider API key environment variable names, keyed by provider ID.
 *
 * Two sources are merged into a single combined map. Both are locally-
 * maintained mirrors of canonical catalogs in `assistant/src/providers/`
 * — the CLI does not import from `assistant/src/`, so drift is caught by
 * dedicated parity tests:
 *
 *   1. LLM-provider env vars — mirrors `PROVIDER_CATALOG` entries with an
 *      `envVar`. Drift guard: `cli/src/__tests__/llm-provider-env-var-parity.test.ts`.
 *   2. Search-provider env vars — mirrors `SEARCH_PROVIDER_CATALOG`
 *      entries with an `envVar`. Drift guard:
 *      `cli/src/__tests__/search-provider-env-var-parity.test.ts`.
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
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  minimax: "MINIMAX_API_KEY",
  atlascloud: "ATLASCLOUD_API_KEY",
  together: "TOGETHER_API_KEY",
  litellm: "LITELLM_API_KEY",
};

/** Search-provider env var names. Mirrors `SEARCH_PROVIDER_CATALOG` BYOK entries. */
export const SEARCH_PROVIDER_ENV_VAR_NAMES: Record<string, string> = {
  perplexity: "PERPLEXITY_API_KEY",
  brave: "BRAVE_API_KEY",
  tavily: "TAVILY_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
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
