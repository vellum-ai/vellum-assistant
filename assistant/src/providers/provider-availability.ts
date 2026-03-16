/**
 * Provider availability checks.
 *
 * Determines which LLM providers are usable by checking secure storage,
 * environment variable fallbacks, and managed proxy availability.
 */

import { API_KEY_PROVIDERS } from "../config/loader.js";
import { getProviderKeyAsync } from "../security/secure-keys.js";
import { managedFallbackEnabledFor } from "./managed-proxy/context.js";

/**
 * Check whether a single provider is usable — via a user-provided key
 * (secure storage or env var) or via the managed proxy fallback.
 * Ollama is always considered available because it does not require an API key.
 */
export async function isProviderAvailable(provider: string): Promise<boolean> {
  if (provider === "ollama") return true;
  return !!(
    (await getProviderKeyAsync(provider)) ||
    (await managedFallbackEnabledFor(provider))
  );
}

/**
 * Build the list of providers that are usable — via a user-provided key
 * (secure storage or env var) or via the managed proxy fallback.
 * Ollama is always included because it does not require an API key.
 */
export async function getConfiguredProviders(): Promise<string[]> {
  const configured: string[] = [];
  for (const p of API_KEY_PROVIDERS) {
    if (await isProviderAvailable(p)) {
      configured.push(p);
    }
  }
  if (!configured.includes("ollama")) configured.push("ollama");
  return configured;
}
