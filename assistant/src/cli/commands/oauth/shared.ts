import type { Command } from "commander";

import { getConfig } from "../../../config/loader.js";
import {
  type Services,
  ServicesSchema,
} from "../../../config/schemas/services.js";
import { getProvider } from "../../../oauth/oauth-store.js";
import { resolveService } from "../../../oauth/provider-behaviors.js";
import { VellumPlatformClient } from "../../../platform/client.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { resolveService };

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface PlatformConnectionEntry {
  id: string;
  account_label?: string;
  scopes_granted?: string[];
  status?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Print a deprecation warning to stderr for renamed commands. Skipped in JSON
 * mode so machine-parseable output is not polluted.
 */
export function printDeprecationWarning(
  oldCmd: string,
  newCmd: string,
  cmd: Command,
): void {
  if (!shouldOutputJson(cmd)) {
    process.stderr.write(
      `Warning: '${oldCmd}' is deprecated. Use '${newCmd}' instead.\n`,
    );
  }
}

/**
 * Extract the bare provider slug (e.g. "google") from either a raw CLI
 * argument or a canonical provider key (e.g. "integration:google").
 * Platform API paths expect the bare slug, not the internal key.
 */
export function toBareProvider(provider: string): string {
  return provider.startsWith("integration:")
    ? provider.slice("integration:".length)
    : provider;
}

/**
 * Return the provider's `managedServiceConfigKey` if it exists and is a valid
 * key in `ServicesSchema.shape`, or `null` otherwise. This centralises the
 * lookup so that callers (e.g. `isManagedMode`, `mode.ts`) don't duplicate the
 * validation.
 */
export function getManagedServiceConfigKey(providerKey: string): string | null {
  const provider = getProvider(providerKey);
  const managedKey = provider?.managedServiceConfigKey;
  if (!managedKey || !(managedKey in ServicesSchema.shape)) return null;
  return managedKey;
}

/**
 * Determine whether a provider is running in platform-managed mode.
 * Returns false if config is unavailable (e.g. in test environments).
 */
export function isManagedMode(providerKey: string): boolean {
  const managedKey = getManagedServiceConfigKey(providerKey);
  if (!managedKey) return false;
  try {
    const services: Services = getConfig().services;
    return services[managedKey as keyof Services].mode === "managed";
  } catch {
    return false;
  }
}

/**
 * Create an authenticated platform client, or write an error and return null.
 */
export async function requirePlatformClient(
  cmd: Command,
): Promise<VellumPlatformClient | null> {
  const client = await VellumPlatformClient.create();
  if (!client || !client.platformAssistantId) {
    writeOutput(cmd, {
      ok: false,
      error:
        "Platform prerequisites not met (not logged in or missing assistant ID)",
    });
    process.exitCode = 1;
    return null;
  }
  return client;
}

/**
 * Fetch active platform connections for a provider. Returns the parsed entries
 * or writes an error and returns null.
 *
 * When `silent` is true the helper returns null on HTTP errors without writing
 * any output — useful inside polling loops where transient failures should be
 * quietly retried rather than emitting multiple error lines.
 */
export async function fetchActiveConnections(
  client: VellumPlatformClient,
  provider: string,
  cmd: Command,
  options?: { silent?: boolean },
): Promise<PlatformConnectionEntry[] | null> {
  const params = new URLSearchParams();
  params.set("provider", toBareProvider(provider));
  params.set("status", "ACTIVE");

  const path = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/connections/?${params.toString()}`;
  const response = await client.fetch(path);

  if (!response.ok) {
    if (!options?.silent) {
      writeOutput(cmd, {
        ok: false,
        error: `Platform returned HTTP ${response.status}`,
      });
      process.exitCode = 1;
    }
    return null;
  }

  const body = (await response.json()) as unknown;

  // The platform returns either a flat array or a {results: [...]} wrapper.
  return (
    Array.isArray(body)
      ? body
      : ((body as Record<string, unknown>).results ?? [])
  ) as PlatformConnectionEntry[];
}
