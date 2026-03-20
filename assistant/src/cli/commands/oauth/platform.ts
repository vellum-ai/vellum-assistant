import type { Command } from "commander";

import { getConfig } from "../../../config/loader.js";
import {
  type Services,
  ServicesSchema,
} from "../../../config/schemas/services.js";
import { getProvider } from "../../../oauth/oauth-store.js";
import { VellumPlatformClient } from "../../../platform/client.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

/**
 * Normalize a bare provider name (e.g. "google") into the canonical provider
 * key used internally (e.g. "integration:google").
 */
function toProviderKey(provider: string): string {
  return provider.startsWith("integration:")
    ? provider
    : `integration:${provider}`;
}

export function registerPlatformCommands(oauth: Command): void {
  const platform = oauth
    .command("platform")
    .description(
      "Query platform-managed OAuth provider status and connections",
    );

  // ---------------------------------------------------------------------------
  // platform status <provider>
  // ---------------------------------------------------------------------------

  platform
    .command("status <provider>")
    .description(
      "Check whether a provider supports managed OAuth and list the user's active connections",
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name (e.g. google, slack, twitter)

Checks whether the platform offers managed OAuth for the given provider,
whether managed mode is currently enabled, and lists any active connections
the user has set up on the platform.

Examples:
  $ assistant oauth platform status google
  $ assistant oauth platform status slack --json`,
    )
    .action(
      async (
        provider: string,
        _opts: Record<string, unknown>,
        cmd: Command,
      ) => {
        try {
          const providerKey = toProviderKey(provider);
          const providerRow = getProvider(providerKey);

          // 1. Check if the provider even supports managed mode
          const managedKey = providerRow?.managedServiceConfigKey;
          if (!managedKey || !(managedKey in ServicesSchema.shape)) {
            writeOutput(cmd, {
              ok: true,
              provider,
              managedAvailable: false,
              managedEnabled: false,
              connections: [],
            });
            if (!shouldOutputJson(cmd)) {
              log.info(
                `Provider "${provider}" does not support platform-managed OAuth`,
              );
            }
            return;
          }

          // 2. Check if managed mode is enabled in the services config
          const services: Services = getConfig().services;
          const managedEnabled =
            services[managedKey as keyof Services].mode === "managed";

          if (!managedEnabled) {
            writeOutput(cmd, {
              ok: true,
              provider,
              managedAvailable: true,
              managedEnabled: false,
              connections: [],
            });
            if (!shouldOutputJson(cmd)) {
              log.info(
                `Provider "${provider}" supports managed OAuth but is set to "your-own" mode`,
              );
            }
            return;
          }

          // 3. Fetch active connections from the platform
          const client = await VellumPlatformClient.create();
          if (!client || !client.platformAssistantId) {
            writeOutput(cmd, {
              ok: false,
              error:
                "Platform prerequisites not met (not logged in or missing assistant ID)",
            });
            process.exitCode = 1;
            return;
          }

          const params = new URLSearchParams();
          params.set("provider", provider);
          params.set("status", "ACTIVE");

          const path = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/connections/?${params.toString()}`;
          const response = await client.fetch(path);

          if (!response.ok) {
            writeOutput(cmd, {
              ok: false,
              error: `Platform returned HTTP ${response.status}`,
            });
            process.exitCode = 1;
            return;
          }

          const body = (await response.json()) as unknown;

          // The platform returns either a flat array or a {results: [...]} wrapper.
          const rawEntries = (
            Array.isArray(body)
              ? body
              : ((body as Record<string, unknown>).results ?? [])
          ) as Array<{
            id: string;
            account_label?: string;
            scopes_granted?: string[];
            status?: string;
          }>;

          const connections = rawEntries.map((c) => ({
            id: c.id,
            accountLabel: c.account_label ?? null,
            scopesGranted: c.scopes_granted ?? [],
            status: c.status ?? "ACTIVE",
          }));

          writeOutput(cmd, {
            ok: true,
            provider,
            managedAvailable: true,
            managedEnabled: true,
            connections,
          });

          if (!shouldOutputJson(cmd)) {
            if (connections.length === 0) {
              log.info(
                `Provider "${provider}" is managed but has no active connections`,
              );
            } else {
              log.info(
                `Provider "${provider}": ${connections.length} active connection(s)`,
              );
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );
}
