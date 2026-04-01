/**
 * @vellumai/provider-env-vars
 *
 * Shared registry mapping provider names to their environment variable names.
 * Source of truth for CLI, assistant daemon, and macOS client.
 */

import registry from "./provider-env-vars.json" with { type: "json" };

export interface ProviderEnvVarsRegistry {
  version: number;
  providers: Record<string, string>;
}

export const providerEnvVarsRegistry: ProviderEnvVarsRegistry = registry;

/**
 * Map of provider name to the environment variable that holds its API key.
 * Convenience re-export of `providerEnvVarsRegistry.providers`.
 */
export const PROVIDER_ENV_VARS: Record<string, string> = registry.providers;
