/**
 * Canonical source for API-key-addressable providers.
 *
 * This module composes the full set of providers that store API keys in
 * secure storage (the `api_key` secret type) from four sources:
 *
 * 1. **LLM providers** -- derived from `PROVIDER_CATALOG`
 *    (`model-catalog.ts`). Adding a provider to the catalog automatically
 *    extends the API-key-addressable set.
 * 2. **Search providers** -- derived from `SEARCH_PROVIDER_CATALOG`
 *    (`search-provider-catalog.ts`). Adding a BYOK search provider to
 *    the catalog automatically extends the API-key-addressable set.
 * 3. **STT providers** -- dynamically derived from the canonical STT
 *    provider catalog by reading credential-provider names.
 * 4. **TTS catalog providers** -- dynamically derived from the canonical
 *    TTS provider catalog by selecting entries whose secret requirements
 *    use the bare-name (non-credential) storage convention.
 *
 * Consumers that need the set of valid API-key provider names should
 * import {@link API_KEY_PROVIDERS} from this module rather than
 * maintaining their own inline arrays.
 */

import { listCatalogProviders } from "../tts/provider-catalog.js";
import { PROVIDER_CATALOG } from "./model-catalog.js";
import { BYOK_SEARCH_PROVIDERS } from "./search-provider-catalog.js";
import { listCredentialProviderNames as listSttCredentialProviderNames } from "./speech-to-text/provider-catalog.js";

// ---------------------------------------------------------------------------
// LLM and search providers
// ---------------------------------------------------------------------------

/**
 * LLM providers that store API keys under their bare provider name in the
 * secure credential store (e.g. `anthropic`, `openai`).
 *
 * Derived from `PROVIDER_CATALOG` so that adding a new LLM provider to the
 * catalog automatically extends the API-key-addressable provider set.
 * `ollama` is intentionally included here even though it is `setupMode:
 * "keyless"` — the keyless mode is enforced elsewhere; this list is purely
 * about the set of bare-name credential-store keys accepted by
 * `assistant keys ...`.
 *
 * Search providers (`brave`, `perplexity`, `tavily`) have no catalog module
 * yet and remain statically declared below.
 */
const LLM_API_KEY_PROVIDERS: readonly string[] = PROVIDER_CATALOG.map(
  (p) => p.id,
);

/**
 * Search API providers, derived from `SEARCH_PROVIDER_CATALOG`. Managed
 * search providers (e.g. `inference-provider-native`) are filtered out;
 * only BYOK entries with a `secretKey` end up here.
 */
const SEARCH_API_KEY_PROVIDERS: readonly string[] = BYOK_SEARCH_PROVIDERS.map(
  (p) => p.secretKey!,
);

const LLM_AND_SEARCH_API_KEY_PROVIDERS: readonly string[] = [
  ...LLM_API_KEY_PROVIDERS,
  ...SEARCH_API_KEY_PROVIDERS,
];

// ---------------------------------------------------------------------------
// STT catalog-derived providers
// ---------------------------------------------------------------------------

/**
 * Derive the deduplicated set of STT credential-provider names from the
 * canonical STT provider catalog, filtering out names that already appear
 * in the LLM/search list to avoid duplicates (e.g. `openai-whisper` maps
 * to `"openai"` which is already present in
 * {@link LLM_AND_SEARCH_API_KEY_PROVIDERS}).
 */
function sttApiKeyProviderNames(): string[] {
  const llmSet = new Set<string>(LLM_AND_SEARCH_API_KEY_PROVIDERS);
  return listSttCredentialProviderNames().filter((name) => !llmSet.has(name));
}

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
 * Derive the set of TTS bare-name credential store keys that use the
 * `api_key` secret type by inspecting the catalog's secret requirements.
 *
 * A TTS provider entry is API-key-addressable when it declares at least
 * one secret whose `credentialStoreKey` is a bare name (i.e. does NOT
 * start with the `credential/` prefix). The bare key name is returned
 * rather than the provider ID because the key name is what appears in
 * the credential store (e.g. `deepgram` not `deepgram-tts`).
 */
function catalogApiKeyNames(): string[] {
  return listCatalogProviders()
    .filter((entry) =>
      entry.secretRequirements.some(
        (s) => !s.credentialStoreKey.startsWith(CREDENTIAL_KEY_PREFIX),
      ),
    )
    .flatMap((entry) =>
      entry.secretRequirements
        .filter((s) => !s.credentialStoreKey.startsWith(CREDENTIAL_KEY_PREFIX))
        .map((s) => s.credentialStoreKey),
    );
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
 * Adding a new LLM provider to `PROVIDER_CATALOG` (`model-catalog.ts`)
 * automatically includes it here. Adding a new BYOK search provider to
 * `SEARCH_PROVIDER_CATALOG` (`search-provider-catalog.ts`) automatically
 * includes it here. Adding a new TTS provider to the TTS catalog with a
 * bare-name secret requirement automatically includes it here. Adding a
 * new STT provider to the STT catalog automatically includes it here.
 * Shared credential names across domains (e.g. `openai` for both LLM
 * and STT; `deepgram` for both STT and TTS) are deduplicated so the
 * list contains no duplicates.
 */
export const API_KEY_PROVIDERS: readonly string[] = (() => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const name of [
    ...LLM_AND_SEARCH_API_KEY_PROVIDERS,
    ...sttApiKeyProviderNames(),
    ...catalogApiKeyNames(),
  ]) {
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }

  return result;
})();
