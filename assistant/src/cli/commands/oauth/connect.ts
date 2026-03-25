import type { Command } from "commander";

import { orchestrateOAuthConnect } from "../../../oauth/connect-orchestrator.js";
import {
  getAppByProviderAndClientId,
  getMostRecentAppByProvider,
  getProvider,
} from "../../../oauth/oauth-store.js";
import { getProviderBehavior } from "../../../oauth/provider-behaviors.js";
import { openInBrowser } from "../../../util/browser.js";
import { getSecureKeyViaDaemon } from "../../lib/daemon-credential-client.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import {
  fetchActiveConnections,
  isManagedMode,
  requirePlatformClient,
} from "./shared.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerConnectCommand(oauth: Command): void {
  oauth
    .command("connect <provider>")
    .description(
      "Initiate an OAuth authorization flow for a specified provider",
    )
    .option("--scopes <scopes...>", "Scopes to request for the authorization")
    .option(
      "--open-browser",
      "Open the auth URL in the browser and wait for completion",
    )
    .option("--client-id <id>", "BYO app client ID disambiguation")
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name (e.g. google, slack, notion).
             Run 'assistant oauth providers list' to see available providers.

Options:
  --scopes <scopes...>   Scopes to request for the authorization. In managed
                         mode, each scope must be in the provider's allowed set
                         (use full scope URLs where required). In BYO mode,
                         scopes are appended to the provider's defaults.
  --open-browser         Open the authorization URL in your browser and wait
                         for completion. In managed mode, polls for a new
                         platform connection. In BYO mode, starts a local
                         callback server and blocks until the OAuth redirect.
  --client-id <id>       BYO-only: select a specific OAuth app when multiple
                         apps exist for the same provider. Ignored for
                         platform-managed providers.

Examples:
  $ assistant oauth connect google
  $ assistant oauth connect google --open-browser
  $ assistant oauth connect google --scopes https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events
  $ assistant oauth connect google --client-id abc123 --open-browser`,
    )
    .action(
      async (
        provider: string,
        opts: {
          scopes?: string[];
          openBrowser?: boolean;
          clientId?: string;
        },
        cmd: Command,
      ) => {
        const jsonMode = shouldOutputJson(cmd);

        // Helper: write an error and set exit code
        const writeError = (error: string): void => {
          writeOutput(cmd, { ok: false, error });
          process.exitCode = 1;
        };

        try {
          // ---------------------------------------------------------------
          // 1. Validate provider exists
          // ---------------------------------------------------------------
          const providerRow = getProvider(provider);
          if (!providerRow) {
            writeError(
              `Unknown provider "${provider}". ` +
                `Run 'assistant oauth providers list' to see available providers.`,
            );
            return;
          }

          // ---------------------------------------------------------------
          // 3. Detect mode
          // ---------------------------------------------------------------
          const managed = isManagedMode(provider);

          if (managed) {
            // =============================================================
            // MANAGED PATH
            // =============================================================

            // Warn about --client-id being ignored in managed mode
            if (opts.clientId) {
              log.info(
                `Warning: --client-id is ignored for platform-managed providers. The platform manages OAuth apps for "${provider}".`,
              );
            }

            const client = await requirePlatformClient(cmd);
            if (!client) return;

            // Call the platform's OAuth start endpoint
            const startPath = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/${encodeURIComponent(provider)}/start/`;

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
              writeError(
                `Platform returned HTTP ${response.status}${errorText ? `: ${errorText}` : ""}`,
              );
              return;
            }

            const result = (await response.json()) as {
              connect_url?: string;
            };

            if (!result.connect_url) {
              writeError(
                "Platform did not return a connect URL — the OAuth flow could not be started",
              );
              return;
            }

            if (opts.openBrowser) {
              // Snapshot existing connection IDs before opening browser
              const snapshotEntries = await fetchActiveConnections(
                client,
                provider,
                cmd,
              );
              if (!snapshotEntries) {
                // fetchActiveConnections already wrote the error output
                return;
              }
              const snapshotIds = new Set(snapshotEntries.map((e) => e.id));

              openInBrowser(result.connect_url);

              if (!jsonMode) {
                log.info(
                  `Opening browser to connect ${provider}. Waiting for authorization...`,
                );
              }

              // Poll for a new connection every 2s for up to 5 minutes
              const pollIntervalMs = 2000;
              const timeoutMs = 5 * 60 * 1000;
              const deadline = Date.now() + timeoutMs;
              let newConnection: {
                id: string;
                account_label?: string;
                scopes_granted?: string[];
              } | null = null;

              while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, pollIntervalMs));

                const currentEntries = await fetchActiveConnections(
                  client,
                  provider,
                  cmd,
                  { silent: true },
                );
                if (!currentEntries) continue;

                const found = currentEntries.find(
                  (e) => !snapshotIds.has(e.id),
                );
                if (found) {
                  newConnection = found;
                  break;
                }
              }

              if (newConnection) {
                // Success — new connection found
                if (jsonMode) {
                  writeOutput(cmd, {
                    ok: true,
                    provider: provider,
                    connectionId: newConnection.id,
                    accountLabel: newConnection.account_label ?? null,
                    scopesGranted: newConnection.scopes_granted ?? [],
                  });
                } else {
                  const label = newConnection.account_label
                    ? ` as ${newConnection.account_label}`
                    : "";
                  process.stdout.write(`Connected to ${provider}${label}\n`);
                }
              } else {
                // Timeout — authorization may still be in progress
                if (jsonMode) {
                  writeOutput(cmd, {
                    ok: true,
                    deferred: true,
                    provider: provider,
                    connectUrl: result.connect_url,
                    message:
                      "Authorization may still be in progress. Check with 'assistant oauth status <provider>'.",
                  });
                } else {
                  process.stdout.write(
                    `Timed out waiting for authorization. It may still be in progress.\n` +
                      `Check with: assistant oauth status ${provider}\n`,
                  );
                }
              }
            } else {
              // No --open-browser: output the connect URL
              if (jsonMode) {
                writeOutput(cmd, {
                  ok: true,
                  deferred: true,
                  connectUrl: result.connect_url,
                  provider: provider,
                });
              } else {
                process.stdout.write(result.connect_url + "\n");
              }
            }
          } else {
            // =============================================================
            // BYO PATH
            // =============================================================

            // a. Resolve client credentials from the DB
            const dbApp = opts.clientId
              ? getAppByProviderAndClientId(provider, opts.clientId)
              : getMostRecentAppByProvider(provider);

            let clientId = opts.clientId;
            let clientSecret: string | undefined;

            if (dbApp) {
              if (!clientId) clientId = dbApp.clientId;
              const storedSecret = await getSecureKeyViaDaemon(
                dbApp.clientSecretCredentialPath,
              );
              if (storedSecret) clientSecret = storedSecret;
            } else if (opts.clientId) {
              // --client-id was explicitly provided but no matching app exists
              writeError(
                `No registered app found for "${provider}" with client ID "${opts.clientId}". ` +
                  `Register one with 'assistant oauth apps upsert'.`,
              );
              return;
            }

            // c. Validate client_id exists
            if (!clientId) {
              writeError(
                `No client_id found for "${provider}". ` +
                  `Register one with 'assistant oauth apps upsert'.`,
              );
              return;
            }

            // d. Check if client_secret is required but missing
            if (clientSecret === undefined) {
              const behavior = getProviderBehavior(provider);

              const requiresSecret =
                behavior?.setup?.requiresClientSecret ??
                !!(
                  providerRow?.tokenEndpointAuthMethod ||
                  providerRow?.extraParams
                );

              if (requiresSecret) {
                writeError(
                  `client_secret is required for ${provider} but not found. ` +
                    `Store it with 'assistant oauth apps upsert --client-secret'.`,
                );
                return;
              }
            }

            // e. Call the orchestrator
            const result = await orchestrateOAuthConnect({
              service: provider,
              clientId,
              clientSecret,
              isInteractive: !!opts.openBrowser,
              openUrl: opts.openBrowser ? openInBrowser : undefined,
              ...(opts.scopes ? { requestedScopes: opts.scopes } : {}),
            });

            // f. Handle results
            if (!result.success) {
              writeError(result.error ?? "OAuth connect failed");
              return;
            }

            if (result.deferred) {
              if (jsonMode) {
                writeOutput(cmd, {
                  ok: true,
                  deferred: true,
                  authUrl: result.authUrl,
                  service: result.service,
                });
              } else {
                process.stdout.write(
                  `\nAuthorize with ${provider}:\n\n${result.authUrl}\n\nThe connection will complete automatically once you authorize.\n`,
                );
              }
              return;
            }

            // Interactive mode completed
            if (jsonMode) {
              writeOutput(cmd, {
                ok: true,
                grantedScopes: result.grantedScopes,
                accountInfo: result.accountInfo,
              });
            } else {
              const msg = `Connected to ${provider}${result.accountInfo ? ` as ${result.accountInfo}` : ""}`;
              process.stdout.write(msg + "\n");
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(message);
        }
      },
    );
}
