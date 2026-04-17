/**
 * Provider metadata for managed proxy routing.
 *
 * Each managed-capable provider maps to a deterministic proxy base path
 * used when routing LLM requests through the platform's managed proxy.
 * Providers marked as non-managed (e.g. ollama) are excluded.
 */

export interface ManagedProviderMeta {
  /** Provider identifier matching the registry name. */
  name: string;
  /** Whether this provider supports managed proxy routing. */
  managed: boolean;
  /** Proxy path segment appended to the platform base URL (only for managed providers). */
  proxyPath?: string;
}

/**
 * Explicit provider metadata for all known providers.
 * Managed providers get a deterministic proxy path; non-managed providers
 * are marked accordingly and have no proxy path.
 *
 * This table describes managed proxy routing capability only. It does not
 * control which providers auto-bootstrap into the text-model registry when
 * managed credentials are present; that policy lives in the registry/context
 * fallback allowlists.
 */
export const MANAGED_PROVIDER_META: Record<string, ManagedProviderMeta> = {
  openai: {
    name: "openai",
    managed: true,
    proxyPath: "/v1/runtime-proxy/openai",
  },
  anthropic: {
    name: "anthropic",
    managed: true,
    proxyPath: "/v1/runtime-proxy/anthropic",
  },
  gemini: {
    name: "gemini",
    managed: true,
    proxyPath: "/v1/runtime-proxy/gemini",
  },
  fireworks: {
    name: "fireworks",
    managed: false,
  },
  openrouter: {
    name: "openrouter",
    managed: false,
  },
  ollama: { name: "ollama", managed: false },
};
