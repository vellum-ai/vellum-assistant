/**
 * Canonical source for API-key-addressable providers.
 *
 * This module composes the full set of providers that store API keys in
 * secure storage (the `api_key` secret type) from two sources:
 *
 * 1. **LLM / search providers** -- statically declared here because they
 *    have no separate catalog module yet.
 * 2. **TTS catalog providers** -- dynamically derived from the canonical
 *    TTS provider catalog by selecting entries whose secret requirements
 *    use the bare-name (non-credential) storage convention.
 *
 * Consumers that need the set of valid API-key provider names should
 * import {@link API_KEY_PROVIDERS} from this module rather than
 * maintaining their own inline arrays.
 */

import { listCatalogProviders } from "../tts/provider-catalog.js";

// ---------------------------------------------------------------------------
// Static LLM / search providers
// ---------------------------------------------------------------------------

/**
 * LLM and search providers that store API keys under their bare provider
 * name in the secure credential store (e.g. `anthropic`, `openai`).
 *
 * These are declared statically because no provider-catalog module exists
 * for them yet. When one is introduced, this array should be replaced with
 * a catalog-derived computation analogous to the TTS logic below.
 */
const LLM_AND_SEARCH_API_KEY_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "openrouter",
  "brave",
  "perplexity",
] as const;

// ---------------------------------------------------------------------------
// TTS catalog-derived providers
// ---------------------------------------------------------------------------

/**
 * The credential-store key prefix used by the namespaced credential type.
 * Secrets stored under this prefix use the `credential` secret type
 * (`assistant credentials set ...`) rather than the `api_key` type
 * (`assistant keys set ...`), so they are excluded from the API-key
 * provider list.
 */
const CREDENTIAL_KEY_PREFIX = "credential/";

/**
 * Derive the set of TTS provider IDs that use the `api_key` secret type
 * by inspecting the catalog's secret requirements.
 *
 * A TTS provider is considered API-key-addressable when it declares at
 * least one secret whose `credentialStoreKey` is a bare name (i.e. does
 * NOT start with the `credential/` prefix).
 */
function catalogApiKeyProviderIds(): string[] {
  return listCatalogProviders()
    .filter((entry) =>
      entry.secretRequirements.some(
        (s) => !s.credentialStoreKey.startsWith(CREDENTIAL_KEY_PREFIX),
      ),
    )
    .map((entry) => entry.id);
}

// ---------------------------------------------------------------------------
// Unified export
// ---------------------------------------------------------------------------

/**
 * All providers that store API keys in secure storage via the `api_key`
 * secret type (`assistant keys set <provider> <key>`).
 *
 * This is the **single authoritative list** consumed by:
 * - Config loader (validation of provider names in `config.json`)
 * - Secret routes (HTTP API key add / read / delete validation)
 * - CLI `keys` command (help text, list iteration)
 * - Provider availability checks
 *
 * Adding a new TTS provider to the catalog with a bare-name secret
 * requirement automatically includes it here. Adding a new LLM or
 * search provider requires appending to
 * {@link LLM_AND_SEARCH_API_KEY_PROVIDERS} until those domains get
 * their own catalog modules.
 */
export const API_KEY_PROVIDERS: readonly string[] = [
  ...LLM_AND_SEARCH_API_KEY_PROVIDERS,
  ...catalogApiKeyProviderIds(),
] as const;
