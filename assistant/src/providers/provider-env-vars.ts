/**
 * LLM provider env-var lookup helper.
 *
 * Resolves the `<PROVIDER>_API_KEY` environment variable name for an LLM
 * provider by consulting the single source of truth (`PROVIDER_CATALOG`)
 * rather than the legacy `meta/provider-env-vars.json` / duplicated
 * `shared/provider-env-vars.ts` map.
 *
 * Returns `undefined` for:
 *   - keyless providers (e.g. Ollama, which has no `envVar` in the catalog)
 *   - unknown provider IDs
 *   - search providers (brave, perplexity) — those live outside the LLM
 *     catalog and remain sourced from `meta/provider-env-vars.json`.
 */
import { PROVIDER_CATALOG } from "./model-catalog.js";

export function getLlmProviderEnvVar(providerId: string): string | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === providerId)?.envVar;
}
