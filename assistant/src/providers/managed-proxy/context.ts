/**
 * Managed proxy context resolver.
 *
 * Resolves the prerequisites for routing LLM provider requests through the
 * platform's managed proxy: the platform base URL and an assistant API key
 * stored as a secure credential.
 *
 * When both are present, providers can be initialized with a managed proxy
 * base URL instead of calling the upstream provider directly.
 */

import { getPlatformBaseUrl } from "../../config/env.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { MANAGED_PROVIDER_META } from "./constants.js";

/** Storage key for the assistant API key credential. */
const ASSISTANT_API_KEY_STORAGE_KEY = credentialKey(
  "vellum",
  "assistant_api_key",
);

export interface ManagedProxyContext {
  /** Whether managed proxy prerequisites are satisfied. */
  enabled: boolean;
  /** Platform base URL (without trailing slash), or empty string if unavailable. */
  platformBaseUrl: string;
  /** Assistant API key for authenticating with the managed proxy, or empty string if unavailable. */
  assistantApiKey: string;
}

/**
 * Cached result of the last `resolveManagedProxyContext()` call.
 * Updated every time the context is resolved (startup, credential changes).
 * Defaults to `false` so that callers see a safe value before the first
 * async resolution completes.
 */
let _managedProxyEnabled = false;

/**
 * Resolve managed proxy context from environment and secure storage.
 *
 * Returns an enabled context only when both the platform base URL and
 * the assistant API key are present. Otherwise returns a disabled context.
 */
export async function resolveManagedProxyContext(): Promise<ManagedProxyContext> {
  const platformBaseUrl = getPlatformBaseUrl().replace(/\/+$/, "");
  const assistantApiKey =
    (await getSecureKeyAsync(ASSISTANT_API_KEY_STORAGE_KEY)).value ?? "";
  const enabled = !!platformBaseUrl && !!assistantApiKey;
  _managedProxyEnabled = enabled;

  return { enabled, platformBaseUrl, assistantApiKey };
}

/**
 * Check whether managed proxy prerequisites are available.
 * Shorthand for checking that both platform URL and assistant API key exist.
 */
export async function hasManagedProxyPrereqs(): Promise<boolean> {
  return (await resolveManagedProxyContext()).enabled;
}

/**
 * Build the full managed proxy base URL for a given provider.
 *
 * Combines the platform base URL with the provider's deterministic proxy path.
 * Returns undefined if the provider is not managed or prerequisites are missing.
 */
export async function buildManagedBaseUrl(
  provider: string,
): Promise<string | undefined> {
  const meta = MANAGED_PROVIDER_META[provider];
  if (!meta?.managed || !meta.proxyPath) return undefined;

  const ctx = await resolveManagedProxyContext();
  if (!ctx.enabled) return undefined;

  return `${ctx.platformBaseUrl}${meta.proxyPath}`;
}

/**
 * Whether managed fallback is enabled for a given provider.
 *
 * Returns true when the provider supports managed proxy routing and
 * all prerequisites (platform URL + assistant API key) are satisfied.
 */
export async function managedFallbackEnabledFor(
  provider: string,
): Promise<boolean> {
  const meta = MANAGED_PROVIDER_META[provider];
  if (!meta?.managed) return false;
  return await hasManagedProxyPrereqs();
}

/**
 * Synchronous check for whether managed proxy prerequisites were satisfied
 * the last time `resolveManagedProxyContext()` ran.
 *
 * Returns `false` before the first async resolution or when the API key is
 * missing. Safe for use in synchronous code paths (e.g. system prompt
 * building) that cannot await the credential store.
 */
export function isManagedProxyEnabledSync(): boolean {
  return _managedProxyEnabled;
}

/** @internal Test-only: reset the cached managed-proxy-enabled flag. */
export function _resetManagedProxyEnabledCache(): void {
  _managedProxyEnabled = false;
}
