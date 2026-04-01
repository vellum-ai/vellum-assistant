/**
 * Provider API key environment variable names, keyed by provider ID.
 *
 * Keep in sync with:
 *   - cli/src/shared/provider-env-vars.ts
 *   - meta/provider-env-vars.json  (consumed by the macOS client build)
 *
 * Once a consolidated shared package exists in packages/, all three
 * copies can be replaced by a single import.
 */
export const PROVIDER_ENV_VAR_NAMES: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  brave: "BRAVE_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};
