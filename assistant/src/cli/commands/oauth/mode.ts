import type { Command } from "commander";

import {
  getConfig,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../../config/loader.js";
import type { Services } from "../../../config/schemas/services.js";
import {
  getProvider,
  listActiveConnectionsByProvider,
} from "../../../oauth/oauth-store.js";
import { VellumPlatformClient } from "../../../platform/client.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import {
  fetchActiveConnections,
  getManagedServiceConfigKey,
  resolveService,
  toBareProvider,
} from "./shared.js";

/**
 * Best-effort helper to count active platform connections for a provider.
 * Returns 0 if the platform client cannot be created or the fetch fails.
 *
 * Uses `VellumPlatformClient.create()` directly (instead of the error-writing
 * `requirePlatformClient`) so that a missing platform session doesn't pollute
 * command output or set a non-zero exit code.
 */
async function countManagedConnections(
  providerKey: string,
  cmd: Command,
): Promise<number> {
  try {
    const client = await VellumPlatformClient.create();
    if (!client || !client.platformAssistantId) return 0;
    const entries = await fetchActiveConnections(client, providerKey, cmd, {
      silent: true,
    });
    return entries?.length ?? 0;
  } catch {
    return 0;
  }
}

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerModeCommand(oauth: Command): void {
  oauth
    .command("mode <provider>")
    .description("Get or set the OAuth mode for a provider")
    .option(
      "--set <mode>",
      'Set the mode to "managed" (platform-handled credentials) or "your-own" (bring-your-own client ID and secret). Omit to show the current mode.',
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider key, alias, or ID (e.g. google, integration:google).
             Run "assistant oauth providers list" to see available providers.

Options:
  --set <mode>   Set the mode to "managed" (platform-handled credentials) or
                 "your-own" (bring-your-own client ID and secret). Omit to
                 show the current mode.

Modes:
  managed    OAuth credentials are managed by the Vellum platform. The
             assistant connects via a platform-hosted authorization flow.
             No local client ID or secret is needed.
  your-own   You supply your own OAuth app credentials (client ID and
             secret). The assistant runs the OAuth flow locally.

Examples:
  $ assistant oauth mode google
  $ assistant oauth mode google --set your-own
  $ assistant oauth mode google --set managed`,
    )
    .action(async (provider: string, opts: { set?: string }, cmd: Command) => {
      try {
        // -----------------------------------------------------------------
        // Resolve + validate provider
        // -----------------------------------------------------------------
        const providerKey = resolveService(provider);
        const providerRow = getProvider(providerKey);

        if (!providerRow) {
          writeOutput(cmd, {
            ok: false,
            error:
              `Unknown provider "${provider}". ` +
              `Run 'assistant oauth providers list' to see available providers.`,
          });
          process.exitCode = 1;
          return;
        }

        const managedKey = getManagedServiceConfigKey(providerKey);

        // -----------------------------------------------------------------
        // GET mode (no --set flag)
        // -----------------------------------------------------------------
        if (opts.set === undefined) {
          if (managedKey === null) {
            // Provider has no managedServiceConfigKey
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, {
                ok: true,
                provider: providerKey,
                mode: "your-own",
                managedModeSupported: false,
              });
            } else {
              log.info(
                `${providerKey} mode: your-own (managed mode not available for this provider)`,
              );
            }
            return;
          }

          // Provider supports managed mode — read current config value
          const services: Services = getConfig().services;
          const currentMode = services[managedKey as keyof Services].mode;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, {
              ok: true,
              provider: providerKey,
              mode: currentMode,
              managedModeSupported: true,
            });
          } else {
            log.info(`${providerKey} mode: ${currentMode}`);
          }
          return;
        }

        // -----------------------------------------------------------------
        // SET mode (--set flag present)
        // -----------------------------------------------------------------
        const newMode = opts.set;

        // Validate mode value
        if (newMode !== "managed" && newMode !== "your-own") {
          writeOutput(cmd, {
            ok: false,
            error: `Invalid mode "${newMode}". Valid values are "managed" or "your-own".`,
          });
          process.exitCode = 1;
          return;
        }

        // Provider has no managedServiceConfigKey — it is always "your-own"
        if (managedKey === null) {
          if (newMode === "your-own") {
            // Already your-own — successful no-op
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, {
                ok: true,
                provider: providerKey,
                mode: "your-own",
                changed: false,
                managedModeSupported: false,
              });
            } else {
              log.info(
                `${providerKey} is already set to your-own (managed mode not available for this provider)`,
              );
            }
            return;
          }

          // Requesting managed on a provider that doesn't support it
          writeOutput(cmd, {
            ok: false,
            error:
              `Managed mode is not available for ${providerKey}. ` +
              `Only providers with platform-managed OAuth support can be switched to managed mode.`,
          });
          process.exitCode = 1;
          return;
        }

        // Read current mode
        const services: Services = getConfig().services;
        const currentMode = services[managedKey as keyof Services].mode;

        // Same mode — no-op
        if (currentMode === newMode) {
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, {
              ok: true,
              provider: providerKey,
              mode: newMode,
              changed: false,
              managedModeSupported: true,
            });
          } else {
            log.info(`${providerKey} is already set to ${newMode}`);
          }
          return;
        }

        // Write the new mode
        const raw = loadRawConfig();
        setNestedValue(raw, `services.${managedKey}.mode`, newMode);
        saveRawConfig(raw);

        // Best-effort check for active connections on old and new modes
        let oldModeConnections = 0;
        let newModeConnections = 0;
        const bareProvider = toBareProvider(providerKey);

        if (currentMode === "managed") {
          // Old mode was managed — check platform connections
          oldModeConnections = await countManagedConnections(providerKey, cmd);
          // New mode is your-own — check local connections
          newModeConnections =
            listActiveConnectionsByProvider(providerKey).length;
        } else {
          // Old mode was your-own — check local connections
          oldModeConnections =
            listActiveConnectionsByProvider(providerKey).length;
          // New mode is managed — check platform connections
          newModeConnections = await countManagedConnections(providerKey, cmd);
        }

        // Build hint if there are connections on the old mode but none on the new
        let hint: string | undefined;
        if (oldModeConnections > 0 && newModeConnections === 0) {
          hint = `No active connections in ${newMode} mode. Run 'assistant oauth connect ${bareProvider}' to connect.`;
        }

        if (shouldOutputJson(cmd)) {
          const result: Record<string, unknown> = {
            ok: true,
            provider: providerKey,
            mode: newMode,
            changed: true,
            managedModeSupported: true,
          };
          if (hint) result.hint = hint;
          writeOutput(cmd, result);
        } else {
          log.info(`${providerKey} mode changed to ${newMode}`);
          if (hint) {
            process.stderr.write(hint + "\n");
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });
}
