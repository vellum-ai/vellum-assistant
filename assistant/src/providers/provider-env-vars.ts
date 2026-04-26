/**
 * Provider env-var lookup helpers.
 *
 * Two sources of truth feed these helpers:
 *
 *   1. LLM providers — names come from `PROVIDER_CATALOG` in
 *      `model-catalog.ts`. `getLlmProviderEnvVar` consults the catalog
 *      directly.
 *   2. Search providers — hardcoded in `SEARCH_PROVIDER_ENV_VAR_NAMES`
 *      below. The env var name follows the pattern `${ID}_API_KEY`.
 *
 * Use `getLlmProviderEnvVar` when you're scoped to LLM providers,
 * `getSearchProviderEnvVar` when you're scoped to search providers, and
 * `getAnyProviderEnvVar` (LLM-first, then search) when you accept either
 * kind — e.g. the generic `getProviderKeyAsync` env-var fallback.
 *
 * Each helper returns `undefined` for keyless providers (e.g. Ollama),
 * unknown IDs, and providers outside the helper's scope.
 */
import { PROVIDER_CATALOG } from "./model-catalog.js";

/** Search-provider env var names. */
const SEARCH_PROVIDER_ENV_VAR_NAMES: Record<string, string> = {
  brave: "BRAVE_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

export function getLlmProviderEnvVar(providerId: string): string | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === providerId)?.envVar;
}

export function getSearchProviderEnvVar(
  providerId: string,
): string | undefined {
  return SEARCH_PROVIDER_ENV_VAR_NAMES[providerId];
}

/**
 * Resolve a provider env-var name from either source — LLM catalog first,
 * then the search-provider mirror. Returns `undefined` when no provider
 * scope declares an env var for the given ID (keyless LLM providers like
 * Ollama, unknown IDs, etc.).
 */
export function getAnyProviderEnvVar(providerId: string): string | undefined {
  return (
    getLlmProviderEnvVar(providerId) ?? getSearchProviderEnvVar(providerId)
  );
}
