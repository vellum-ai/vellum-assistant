import type { Command } from "commander";

import { getConfig } from "../../../config/loader.js";
import {
  type Services,
  ServicesSchema,
} from "../../../config/schemas/services.js";
import { getProvider } from "../../../oauth/oauth-store.js";
import { openInBrowser } from "../../../util/browser.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import {
  fetchActiveConnections,
  requirePlatformClient,
  toBareProvider,
} from "./shared.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Platform-specific helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a bare provider name (e.g. "google") into the canonical provider
 * key used internally (e.g. "integration:google").
 */
function toProviderKey(provider: string): string {
  return provider.startsWith("integration:")
    ? provider
    : `integration:${provider}`;
}

/**
 * Validate that a provider supports managed OAuth (has a managedServiceConfigKey).
 * Does NOT check whether managed mode is currently enabled — use this for
 * operations that should work regardless of the current mode (e.g. disconnect).
 * Returns the managed config key on success, or writes an error and returns null.
 */
function requireManagedCapableProvider(
  provider: string,
  cmd: Command,
): string | null {
  const providerKey = toProviderKey(provider);
  const providerRow = getProvider(providerKey);

  const managedKey = providerRow?.managedServiceConfigKey;
  if (!managedKey || !(managedKey in ServicesSchema.shape)) {
    writeOutput(cmd, {
      ok: false,
      error: `Provider "${provider}" does not support platform-managed OAuth`,
    });
    process.exitCode = 1;
    return null;
  }

  return managedKey;
}

/**
 * Validate that a provider supports managed OAuth AND that managed mode is
 * currently enabled. Use this for operations that require active managed
 * mode (e.g. connect). Returns the managed config key on success, or writes
 * an error and returns null.
 */
function requireManagedProvider(provider: string, cmd: Command): string | null {
  const managedKey = requireManagedCapableProvider(provider, cmd);
  if (!managedKey) return null;

  const services: Services = getConfig().services;
  const managedEnabled =
    services[managedKey as keyof Services].mode === "managed";

  if (!managedEnabled) {
    writeOutput(cmd, {
      ok: false,
      error: `Provider "${provider}" supports managed OAuth but is set to "your-own" mode`,
    });
    process.exitCode = 1;
    return null;
  }

  return managedKey;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPlatformCommands(oauth: Command): void {
  const platform = oauth
    .command("platform")
    .description(
      "Manage platform-managed OAuth provider status and connections",
    );

  registerStatusCommand(platform);
  registerConnectCommand(platform);
  registerDisconnectCommand(platform);
}

// ---------------------------------------------------------------------------
// platform status <provider>
// ---------------------------------------------------------------------------

function registerStatusCommand(platform: Command): void {
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
          const client = await requirePlatformClient(cmd);
          if (!client) return;

          const rawEntries = await fetchActiveConnections(
            client,
            provider,
            cmd,
          );
          if (!rawEntries) return;

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

// ---------------------------------------------------------------------------
// platform connect <provider>
// ---------------------------------------------------------------------------

function registerConnectCommand(platform: Command): void {
  platform
    .command("connect <provider>")
    .description(
      "Initiate a platform-managed OAuth flow for a provider and open the browser",
    )
    .option(
      "--scopes <scopes...>",
      "Exact OAuth scopes to request (must be a subset of the provider's allowed scopes)",
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name (e.g. google, slack, twitter)

Starts a platform-managed OAuth authorization flow by calling the platform's
/start/ endpoint, then opens the returned authorization URL in the user's
browser. The user completes consent in the browser; the platform handles the
callback, token exchange, and credential storage.

The provider must support managed OAuth and managed mode must be enabled in
the services config.

Scope behavior:
  Without --scopes, the platform requests ALL of the provider's allowed scopes.
  With --scopes, only the specified scopes are requested (no merging with
  defaults). Each scope must be in the provider's allowed set or the platform
  will reject it. Use full scope URLs where required (e.g. Google scopes use
  https://www.googleapis.com/auth/... format).

Examples:
  $ assistant oauth platform connect google
  $ assistant oauth platform connect google --scopes https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events
  $ assistant oauth platform connect google --json`,
    )
    .action(
      async (provider: string, opts: { scopes?: string[] }, cmd: Command) => {
        try {
          if (!requireManagedProvider(provider, cmd)) return;

          const client = await requirePlatformClient(cmd);
          if (!client) return;

          // Call the platform's OAuth start endpoint
          const startPath = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/${encodeURIComponent(toBareProvider(provider))}/start/`;

          const body: Record<string, unknown> = {};
          if (opts.scopes && opts.scopes.length > 0) {
            body.requested_scopes = opts.scopes;
          }

          const response = await client.fetch(startPath, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

          if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            writeOutput(cmd, {
              ok: false,
              error: `Platform returned HTTP ${response.status}${errorText ? `: ${errorText}` : ""}`,
            });
            process.exitCode = 1;
            return;
          }

          const result = (await response.json()) as {
            connect_url?: string;
          };

          if (!result.connect_url) {
            writeOutput(cmd, {
              ok: false,
              error:
                "Platform did not return a connect URL — the OAuth flow could not be started",
            });
            process.exitCode = 1;
            return;
          }

          openInBrowser(result.connect_url);

          writeOutput(cmd, {
            ok: true,
            deferred: true,
            provider,
            connectUrl: result.connect_url,
          });

          if (!shouldOutputJson(cmd)) {
            log.info(
              `Opening browser to connect ${provider}. Complete the authorization in your browser.`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );
}

// ---------------------------------------------------------------------------
// platform disconnect <provider>
// ---------------------------------------------------------------------------

function registerDisconnectCommand(platform: Command): void {
  platform
    .command("disconnect <provider>")
    .description(
      "Disconnect a platform-managed OAuth connection for a provider",
    )
    .option(
      "--connection-id <id>",
      "Specific connection ID to disconnect (required when multiple active connections exist)",
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name (e.g. google, slack, twitter)

Disconnects a platform-managed OAuth connection by calling the platform's
/disconnect/ endpoint, which revokes the connection.

If the provider has multiple active connections, use --connection-id to specify
which one to disconnect. Without --connection-id, the command disconnects the
sole active connection or fails with a list of active connections if there are
multiple.

Examples:
  $ assistant oauth platform disconnect google
  $ assistant oauth platform disconnect google --connection-id conn_abc123
  $ assistant oauth platform disconnect google --json`,
    )
    .action(
      async (
        provider: string,
        opts: { connectionId?: string },
        cmd: Command,
      ) => {
        try {
          if (!requireManagedCapableProvider(provider, cmd)) return;

          const client = await requirePlatformClient(cmd);
          if (!client) return;

          // Always fetch active connections for the provider so we can
          // verify --connection-id belongs to it (prevents cross-provider
          // disconnects from typos or stale IDs).
          const entries = await fetchActiveConnections(client, provider, cmd);
          if (!entries) return;

          let connectionId = opts.connectionId;

          if (connectionId) {
            // Verify the supplied ID belongs to this provider
            if (!entries.some((c) => c.id === connectionId)) {
              writeOutput(cmd, {
                ok: false,
                error: `Connection "${connectionId}" is not an active ${provider} connection`,
              });
              process.exitCode = 1;
              return;
            }
          } else {
            if (entries.length === 0) {
              writeOutput(cmd, {
                ok: false,
                error: `No active connections found for provider "${provider}"`,
              });
              process.exitCode = 1;
              return;
            }

            if (entries.length > 1) {
              const connectionList = entries.map((c) => ({
                id: c.id,
                accountLabel: c.account_label ?? null,
              }));
              writeOutput(cmd, {
                ok: false,
                error: `Multiple active connections for "${provider}". Use --connection-id to specify which one to disconnect.`,
                connections: connectionList,
              });
              process.exitCode = 1;
              return;
            }

            connectionId = entries[0].id;
          }

          // Disconnect the connection
          const disconnectPath = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/connections/${encodeURIComponent(connectionId)}/disconnect/`;
          const disconnectResponse = await client.fetch(disconnectPath, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });

          if (!disconnectResponse.ok) {
            const errorText = await disconnectResponse.text().catch(() => "");
            writeOutput(cmd, {
              ok: false,
              error: `Platform returned HTTP ${disconnectResponse.status}${errorText ? `: ${errorText}` : ""}`,
            });
            process.exitCode = 1;
            return;
          }

          writeOutput(cmd, {
            ok: true,
            provider,
            connectionId,
          });

          if (!shouldOutputJson(cmd)) {
            log.info(`Disconnected ${provider} connection ${connectionId}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );
}
