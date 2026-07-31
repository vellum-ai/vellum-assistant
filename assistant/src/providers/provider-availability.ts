/**
 * Provider availability checks.
 *
 * Determines which LLM providers are usable by checking secure storage,
 * environment variable fallbacks, and managed proxy availability.
 */

import { getConfig } from "../config/loader.js";
import {
  getProviderKeyAsync,
  getSecureKeyResultAsync,
} from "../security/secure-keys.js";
import { PROVIDER_CATALOG } from "./model-catalog.js";
import { managedFallbackEnabledFor } from "./platform-proxy/context.js";
import { getVisibleProviderCatalog } from "./provider-catalog-visibility.js";
import { API_KEY_PROVIDERS } from "./provider-secret-catalog.js";

/**
 * Check whether a single provider is usable — via a user-provided key
 * (secure storage or env var) or via the managed proxy fallback.
 * Ollama is always considered available because it does not require an API key.
 */
export async function isProviderAvailable(provider: string): Promise<boolean> {
  if (provider === "ollama") {
    return true;
  }
  return !!(
    (await getProviderKeyAsync(provider)) ||
    (await managedFallbackEnabledFor(provider))
  );
}

/**
 * Build the list of providers that are usable — via a user-provided key
 * (secure storage or env var) or via the managed proxy fallback.
 * Feature-flagged LLM providers that are currently disabled are excluded.
 * Ollama is always included because it does not require an API key.
 */
export async function getConfiguredProviders(): Promise<string[]> {
  // Build the set of LLM providers hidden by feature flags so we can
  // exclude them while leaving non-LLM providers (search, STT, TTS)
  // in API_KEY_PROVIDERS unchanged.
  const allLlmIds = new Set(PROVIDER_CATALOG.map((p) => p.id));
  const visibleLlmIds = new Set(
    getVisibleProviderCatalog(getConfig()).map((p) => p.id),
  );
  const hiddenLlmIds = new Set(
    [...allLlmIds].filter((id) => !visibleLlmIds.has(id)),
  );

  const configured: string[] = [];
  for (const p of API_KEY_PROVIDERS) {
    if (hiddenLlmIds.has(p)) {
      continue;
    }
    if (await isProviderAvailable(p)) {
      configured.push(p);
    }
  }
  if (!configured.includes("ollama")) {
    configured.push("ollama");
  }
  return configured;
}

export type CredentialPresence = "present" | "absent" | "indeterminate";

/**
 * Non-plaintext existence probe for a stored credential. Never returns the
 * secret — modules that only need "is a key stored?" use this instead of
 * importing secure-keys (which the credential-security invariant restricts
 * to an allowlist). `indeterminate` means the credential store was
 * unreachable: callers must not treat it as absent.
 */
export async function checkCredentialPresence(
  account: string,
): Promise<CredentialPresence> {
  const result = await getSecureKeyResultAsync(account);
  if (result.unreachable) {
    return "indeterminate";
  }
  return result.value != null ? "present" : "absent";
}
