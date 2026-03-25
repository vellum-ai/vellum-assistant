import { createServer, type Server } from "node:http";

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
  resolveService,
} from "./shared.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Managed OAuth redirect page
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderOAuthCompletePage(message: string, success: boolean): string {
  const title = success ? "Authorization Successful" : "Authorization Failed";
  const color = success ? "#4CAF50" : "#f44336";
  const icon = success ? "&#10003;" : "&#10007;";
  return `<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}div{text-align:center;padding:2.5rem;background:white;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);max-width:420px}.icon{font-size:3rem;color:${color};margin-bottom:0.5rem}h1{color:#333;font-size:1.4rem;margin:0.5rem 0}p{color:#666;font-size:0.95rem;line-height:1.5}</style></head><body><div><div class="icon">${icon}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

/**
 * Start a temporary loopback server to serve a nice completion page after the
 * platform redirects the user's browser following a managed OAuth flow.
 * Returns the base URL and a cleanup function.
 */
function startManagedRedirectServer(): Promise<{
  redirectUrl: string;
  cleanup: () => void;
}> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const error = url.searchParams.get("error");
      const errorDesc = url.searchParams.get("error_description");

      if (error) {
        const message = errorDesc ?? error;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(renderOAuthCompletePage(message, false));
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          renderOAuthCompletePage(
            "You can close this tab and return to your terminal.",
            true,
          ),
        );
      }
    });

    server.listen(0, "localhost", () => {
      const addr = server.address() as { port: number };
      const redirectUrl = `http://localhost:${addr.port}/oauth/complete`;
      resolve({
        redirectUrl,
        cleanup: () => server.close(),
      });
    });

    server.on("error", (err) => {
      reject(new Error(`Failed to start redirect server: ${err.message}`));
    });
  });
}

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
  provider   Provider name (e.g. google, slack, gmail).
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
  $ assistant oauth connect gmail --open-browser
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
          // 1. Resolve provider key
          // ---------------------------------------------------------------
          const providerKey = resolveService(provider);

          // ---------------------------------------------------------------
          // 2. Validate provider exists
          // ---------------------------------------------------------------
          const providerRow = getProvider(providerKey);
          if (!providerRow) {
            writeError(
              `Unknown provider "${providerKey}". ` +
                `Run 'assistant oauth providers list' to see available providers.`,
            );
            return;
          }

          // ---------------------------------------------------------------
          // 3. Detect mode
          // ---------------------------------------------------------------
          const managed = isManagedMode(providerKey);

          if (managed) {
            // =============================================================
            // MANAGED PATH
            // =============================================================

            // Warn about --client-id being ignored in managed mode
            if (opts.clientId) {
              log.info(
                `Warning: --client-id is ignored for platform-managed providers. The platform manages OAuth apps for "${providerKey}".`,
              );
            }

            const client = await requirePlatformClient(cmd);
            if (!client) return;

            // Call the platform's OAuth start endpoint
            const startPath = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/${encodeURIComponent(providerKey)}/start/`;

            const body: Record<string, unknown> = {};
            if (opts.scopes && opts.scopes.length > 0) {
              body.requested_scopes = opts.scopes;
            }

            // When opening the browser, start a local server to show a nice
            // completion page instead of redirecting to the platform website.
            let redirectServer:
              | { redirectUrl: string; cleanup: () => void }
              | undefined;
            if (opts.openBrowser) {
              try {
                redirectServer = await startManagedRedirectServer();
                body.redirect_after_connect = redirectServer.redirectUrl;
              } catch {
                // Non-fatal — fall back to platform default redirect
              }
            }

            const response = await client.fetch(startPath, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });

            if (!response.ok) {
              redirectServer?.cleanup();
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
              redirectServer?.cleanup();
              writeError(
                "Platform did not return a connect URL — the OAuth flow could not be started",
              );
              return;
            }

            if (opts.openBrowser) {
              // Snapshot existing connection IDs before opening browser
              const snapshotEntries = await fetchActiveConnections(
                client,
                providerKey,
                cmd,
              );
              if (!snapshotEntries) {
                redirectServer?.cleanup();
                // fetchActiveConnections already wrote the error output
                return;
              }
              const snapshotIds = new Set(snapshotEntries.map((e) => e.id));

              openInBrowser(result.connect_url);

              if (!jsonMode) {
                log.info(
                  `Opening browser to connect ${providerKey}. Waiting for authorization...`,
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
                  providerKey,
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

              // Clean up the redirect server now that polling is done
              redirectServer?.cleanup();

              if (newConnection) {
                // Success — new connection found
                if (jsonMode) {
                  writeOutput(cmd, {
                    ok: true,
                    provider: providerKey,
                    connectionId: newConnection.id,
                    accountLabel: newConnection.account_label ?? null,
                    scopesGranted: newConnection.scopes_granted ?? [],
                  });
                } else {
                  const label = newConnection.account_label
                    ? ` as ${newConnection.account_label}`
                    : "";
                  process.stdout.write(`Connected to ${providerKey}${label}\n`);
                }
              } else {
                // Timeout — authorization may still be in progress
                if (jsonMode) {
                  writeOutput(cmd, {
                    ok: true,
                    deferred: true,
                    provider: providerKey,
                    connectUrl: result.connect_url,
                    message:
                      "Authorization may still be in progress. Check with 'assistant oauth status <provider>'.",
                  });
                } else {
                  process.stdout.write(
                    `Timed out waiting for authorization. It may still be in progress.\n` +
                      `Check with: assistant oauth status ${providerKey}\n`,
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
                  provider: providerKey,
                });
              } else {
                process.stdout.write(result.connect_url + "\n");
              }
            }
          } else {
            // =============================================================
            // BYO PATH
            // =============================================================

            // a. Resolve service alias (already done above via resolveService)
            const resolvedServiceKey = providerKey;

            // b. Resolve client credentials from the DB
            const dbApp = opts.clientId
              ? getAppByProviderAndClientId(resolvedServiceKey, opts.clientId)
              : getMostRecentAppByProvider(resolvedServiceKey);

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
                `No registered app found for "${resolvedServiceKey}" with client ID "${opts.clientId}". ` +
                  `Register one with 'assistant oauth apps upsert'.`,
              );
              return;
            }

            // c. Validate client_id exists
            if (!clientId) {
              writeError(
                `No client_id found for "${resolvedServiceKey}". ` +
                  `Register one with 'assistant oauth apps upsert'.`,
              );
              return;
            }

            // d. Check if client_secret is required but missing
            if (clientSecret === undefined) {
              const behavior = getProviderBehavior(resolvedServiceKey);

              const requiresSecret =
                behavior?.setup?.requiresClientSecret ??
                !!(
                  providerRow?.tokenEndpointAuthMethod ||
                  providerRow?.extraParams
                );

              if (requiresSecret) {
                writeError(
                  `client_secret is required for ${resolvedServiceKey} but not found. ` +
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
                  `\nAuthorize with ${resolvedServiceKey}:\n\n${result.authUrl}\n\nThe connection will complete automatically once you authorize.\n`,
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
              const msg = `Connected to ${resolvedServiceKey}${result.accountInfo ? ` as ${result.accountInfo}` : ""}`;
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
