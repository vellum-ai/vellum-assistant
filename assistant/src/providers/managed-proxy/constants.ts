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
    proxyPath: "/v1/runtime-proxy/vertex",
  },
  gemini: {
    name: "gemini",
    managed: true,
    proxyPath: "/v1/runtime-proxy/vertex",
  },
  fireworks: {
    name: "fireworks",
    managed: true,
    proxyPath: "/v1/runtime-proxy/fireworks",
  },
  openrouter: {
    name: "openrouter",
    managed: true,
    proxyPath: "/v1/runtime-proxy/openrouter",
  },
  vertex: {
    name: "vertex",
    managed: true,
    proxyPath: "/v1/runtime-proxy/vertex",
  },
  ollama: { name: "ollama", managed: false },
};

/** Provider names that support managed proxy routing. */
export const MANAGED_PROVIDER_NAMES = Object.entries(MANAGED_PROVIDER_META)
  .filter(([, meta]) => meta.managed)
  .map(([name]) => name);
