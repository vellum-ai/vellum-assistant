import type { Command } from "commander";

import { getConfig } from "../../../config/loader.js";
import {
  type Services,
  ServicesSchema,
} from "../../../config/schemas/services.js";
import { fetchManagedCatalog } from "../../../credential-execution/managed-catalog.js";
import { getProvider } from "../../../oauth/oauth-store.js";
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

          // 3. Fetch active connections via the managed catalog endpoint
          const catalogResult = await fetchManagedCatalog();

          if (!catalogResult.ok) {
            writeOutput(cmd, {
              ok: false,
              error: catalogResult.error ?? "Failed to fetch managed catalog",
            });
            process.exitCode = 1;
            return;
          }

          // Filter catalog to the requested provider
          const connections = catalogResult.descriptors
            .filter((d) => d.provider.toLowerCase() === provider.toLowerCase())
            .map((d) => ({
              id: d.connectionId,
              accountLabel: d.accountInfo,
              scopesGranted: d.grantedScopes,
              status: d.status,
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
