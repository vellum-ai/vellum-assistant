import type { Command } from "commander";

import {
  disconnectOAuthProvider,
  getActiveConnection,
  getConnection,
  getProvider,
  listActiveConnectionsByProvider,
} from "../../../oauth/oauth-store.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import {
  fetchActiveConnections,
  isManagedMode,
  requirePlatformClient,
  resolveService,
} from "./shared.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerDisconnectCommand(oauth: Command): void {
  oauth
    .command("disconnect <provider>")
    .description(
      "Disconnect an OAuth provider and remove associated credentials",
    )
    .option(
      "--account <identifier>",
      "Account identifier to disconnect (e.g. email address)",
    )
    .option("--connection-id <id>", "Exact connection ID to disconnect")
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name (e.g. google, slack, notion).
             Run 'assistant oauth providers list' to see available providers.

Options:
  --account          Recommended way to specify which connection to disconnect.
                     Works for both managed and BYO modes. Use the account
                     identifier shown by 'assistant oauth status <provider>'
                     (e.g. an email address for Google).
  --connection-id    Exact match on the connection ID shown by
                     'assistant oauth status <provider>'. Useful when account
                     labels are ambiguous or absent.

  At most one of --account or --connection-id may be specified.

Disambiguation:
  When a provider has multiple active connections and neither --account nor
  --connection-id is given, the command errors with a list of connections
  (id + account label) and a hint to use --account or --connection-id.
  Run 'assistant oauth status <provider>' to discover available values.

Examples:
  $ assistant oauth disconnect google
  $ assistant oauth disconnect google --account user@gmail.com
  $ assistant oauth disconnect google --connection-id conn_abc123`,
    )
    .action(
      async (
        provider: string,
        opts: { account?: string; connectionId?: string },
        cmd: Command,
      ) => {
        const jsonMode = shouldOutputJson(cmd);

        // Helper: write an error and set exit code
        const writeError = (
          error: string,
          extra?: Record<string, unknown>,
        ): void => {
          writeOutput(cmd, { ok: false, error, ...extra });
          process.exitCode = 1;
        };

        try {
          // -------------------------------------------------------------------
          // 1. Resolve + validate provider
          // -------------------------------------------------------------------
          const providerKey = resolveService(provider);

          const providerRow = getProvider(providerKey);
          if (!providerRow) {
            writeError(
              `Unknown provider "${provider}".\n\n` +
                `Run 'assistant oauth providers list' to see available providers.\n` +
                `If this is a custom provider, register it first with 'assistant oauth providers register --help'.`,
            );
            return;
          }

          // -------------------------------------------------------------------
          // 2. Validate mutual exclusivity
          // -------------------------------------------------------------------
          if (opts.account && opts.connectionId) {
            writeError(
              `Cannot specify both --account and --connection-id. Use one or the other.\n\n` +
                `Run 'assistant oauth status ${provider}' to see connected accounts and IDs.`,
            );
            return;
          }

          // -------------------------------------------------------------------
          // 3. Detect mode
          // -------------------------------------------------------------------
          const managed = isManagedMode(providerKey);

          if (managed) {
            // -----------------------------------------------------------------
            // Managed path
            // -----------------------------------------------------------------
            const client = await requirePlatformClient(cmd);
            if (!client) return;

            const entries = await fetchActiveConnections(
              client,
              providerKey,
              cmd,
            );
            if (!entries) return;

            let connectionId: string | undefined;
            let accountLabel: string | undefined;

            if (opts.account) {
              // Filter connections by account_label matching the account value
              const matching = entries.filter(
                (c) => c.account_label === opts.account,
              );
              if (matching.length === 0) {
                writeError(
                  `No active connection found for "${providerKey}" with account "${opts.account}".\n\n` +
                    `Run 'assistant oauth status ${provider}' to see connected accounts.`,
                );
                return;
              }
              connectionId = matching[0].id;
              accountLabel = matching[0].account_label;
            } else if (opts.connectionId) {
              // Verify the supplied ID belongs to this provider
              const match = entries.find((c) => c.id === opts.connectionId);
              if (!match) {
                writeError(
                  `Connection "${opts.connectionId}" is not an active ${providerKey} connection.\n\n` +
                    `Run 'assistant oauth status ${provider}' to see active connections.`,
                );
                return;
              }
              connectionId = match.id;
              accountLabel = match.account_label;
            } else {
              // Neither specified — auto-resolve
              if (entries.length === 0) {
                writeError(
                  `No active connections found for "${providerKey}".\n\n` +
                    `Run 'assistant oauth status ${provider}' to check connection status.`,
                );
                return;
              }

              if (entries.length > 1) {
                const connectionList = entries.map((c) => ({
                  id: c.id,
                  account: c.account_label ?? null,
                }));
                writeError(
                  `Multiple active connections for "${providerKey}". ` +
                    `Specify which one to disconnect with --account or --connection-id.\n\n` +
                    `Run 'assistant oauth status ${provider}' to see connected accounts and IDs.`,
                  { connections: connectionList },
                );
                return;
              }

              connectionId = entries[0].id;
              accountLabel = entries[0].account_label;
            }

            // Call platform /disconnect/ endpoint
            const disconnectPath = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/connections/${encodeURIComponent(connectionId)}/disconnect/`;
            const disconnectResponse = await client.fetch(disconnectPath, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
            });

            if (!disconnectResponse.ok) {
              const errorText = await disconnectResponse.text().catch(() => "");
              writeError(
                `Platform returned HTTP ${disconnectResponse.status}${errorText ? `: ${errorText}` : ""}`,
              );
              return;
            }

            const result: Record<string, unknown> = {
              ok: true,
              provider: providerKey,
              connectionId,
            };
            if (accountLabel) result.account = accountLabel;
            writeOutput(cmd, result);

            if (!jsonMode) {
              log.info(
                `Disconnected ${providerKey} connection ${connectionId}`,
              );
            }
          } else {
            // -----------------------------------------------------------------
            // BYO path
            // -----------------------------------------------------------------
            let connectionId: string | undefined;
            let accountLabel: string | undefined;

            if (opts.account) {
              const conn = getActiveConnection(providerKey, {
                account: opts.account,
              });
              if (!conn) {
                writeError(
                  `No active connection found for "${providerKey}" with account "${opts.account}".\n\n` +
                    `Run 'assistant oauth status ${provider}' to see connected accounts.`,
                );
                return;
              }
              connectionId = conn.id;
              accountLabel = conn.accountInfo ?? undefined;
            } else if (opts.connectionId) {
              const conn = getConnection(opts.connectionId);
              if (!conn || conn.providerKey !== providerKey) {
                writeError(
                  `Connection "${opts.connectionId}" is not an active ${providerKey} connection.\n\n` +
                    `Run 'assistant oauth status ${provider}' to see active connections.`,
                );
                return;
              }
              connectionId = conn.id;
              accountLabel = conn.accountInfo ?? undefined;
            } else {
              // Neither specified — auto-resolve
              const active = listActiveConnectionsByProvider(providerKey);

              if (active.length === 0) {
                writeError(
                  `No active connections found for "${providerKey}".\n\n` +
                    `Run 'assistant oauth status ${provider}' to check connection status.`,
                );
                return;
              }

              if (active.length > 1) {
                const connectionList = active.map((c) => ({
                  id: c.id,
                  account: c.accountInfo ?? null,
                }));
                writeError(
                  `Multiple active connections for "${providerKey}". ` +
                    `Specify which one to disconnect with --account or --connection-id.\n\n` +
                    `Run 'assistant oauth status ${provider}' to see connected accounts and IDs.`,
                  { connections: connectionList },
                );
                return;
              }

              connectionId = active[0].id;
              accountLabel = active[0].accountInfo ?? undefined;
            }

            // Disconnect the OAuth connection (tokens + connection row)
            const oauthResult = await disconnectOAuthProvider(
              providerKey,
              undefined,
              connectionId,
            );
            if (oauthResult === "error") {
              writeError(
                `Failed to disconnect OAuth provider "${providerKey}" — please try again.`,
              );
              return;
            }

            const result: Record<string, unknown> = {
              ok: true,
              provider: providerKey,
              connectionId,
            };
            if (accountLabel) result.account = accountLabel;
            writeOutput(cmd, result);

            if (!jsonMode) {
              log.info(
                `Disconnected ${providerKey} connection ${connectionId}`,
              );
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(message);
        }
      },
    );
}
