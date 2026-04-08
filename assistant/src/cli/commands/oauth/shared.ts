import type { Command } from "commander";

import { getConfig } from "../../../config/loader.js";
import {
  type Services,
  ServicesSchema,
} from "../../../config/schemas/services.js";
import { getProvider } from "../../../oauth/oauth-store.js";
import { VellumPlatformClient } from "../../../platform/client.js";
import { writeOutput } from "../../output.js";

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
 * Return the provider's `managedServiceConfigKey` if it exists and is a valid
 * key in `ServicesSchema.shape`, or `null` otherwise. This centralises the
 * lookup so that callers (e.g. `isManagedMode`, `mode.ts`) don't duplicate the
 * validation.
 */
export function getManagedServiceConfigKey(provider: string): string | null {
  const providerRow = getProvider(provider);
  const managedKey = providerRow?.managedServiceConfigKey;
  if (!managedKey || !(managedKey in ServicesSchema.shape)) return null;
  return managedKey;
}

/**
 * Determine whether a provider is running in platform-managed mode.
 * Returns false if config is unavailable (e.g. in test environments).
 */
export function isManagedMode(provider: string): boolean {
  const managedKey = getManagedServiceConfigKey(provider);
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
  if (!client) {
    writeOutput(cmd, {
      ok: false,
      error:
        "Not connected to Vellum platform. Run `vellum platform connect` to connect first.",
    });
    process.exitCode = 1;
    return null;
  }
  if (!client.platformAssistantId) {
    writeOutput(cmd, {
      ok: false,
      error:
        "Connected to Vellum platform but no assistant ID is configured. Ensure the assistant is registered on the platform.",
    });
    process.exitCode = 1;
    return null;
  }
  return client;
}

/**
 * Verify that the user has connected to the Vellum platform (has stored
 * credentials). Unlike `requirePlatformClient`, this does NOT require a
 * platform assistant ID — it only checks that credentials exist.
 *
 * Writes an error and sets exitCode=1 when the user is not connected.
 */
export async function requirePlatformConnection(
  cmd: Command,
): Promise<boolean> {
  const client = await VellumPlatformClient.create();
  if (!client) {
    writeOutput(cmd, {
      ok: false,
      error:
        "Not connected to Vellum platform. Run `vellum platform connect` to connect first.",
    });
    process.exitCode = 1;
    return false;
  }
  return true;
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
  params.set("provider", provider);
  params.set("status", "ACTIVE");

  const path = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/connections/?${params.toString()}`;
  const response = await client.fetch(path);

  if (!response.ok) {
    if (!options?.silent) {
      const hint =
        response.status === 401 || response.status === 403
          ? `. Your platform session may have expired. Run \`vellum platform connect\` to reconnect.`
          : "";
      writeOutput(cmd, {
        ok: false,
        error: `Platform returned HTTP ${response.status}${hint}`,
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
