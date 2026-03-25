import { createServer } from "node:http";

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
  toBareProvider,
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
  provider   Provider key, alias, or ID from 'assistant oauth providers list'.
             Accepts canonical keys (e.g. integration:google), aliases (e.g.
             gmail), or bare provider names (e.g. google).

Options:
  --scopes <scopes...>   Scopes to request for the authorization. In managed
                         mode, each scope must be in the provider's allowed set
                         (use full scope URLs where required). In BYO mode,
                         scopes are appended to the provider's defaults.
  --open-browser         Open the authorization URL in your browser and wait
                         for completion. Uses a local callback server to
                         receive the redirect when authorization finishes.
  --client-id <id>       BYO-only: select a specific OAuth app when multiple
                         apps exist for the same provider. Ignored for
                         platform-managed providers.

Examples:
  $ assistant oauth connect google
  $ assistant oauth connect gmail --open-browser
  $ assistant oauth connect integration:google --scopes https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events
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
            const startPath = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/${encodeURIComponent(toBareProvider(providerKey))}/start/`;

            // When --open-browser, start a loopback server first so we can
            // pass its URL as redirect_after_connect in a single request.
            let loopback:
              | Awaited<ReturnType<typeof startManagedLoopbackServer>>
              | undefined;
            if (opts.openBrowser) {
              loopback = await startManagedLoopbackServer();
            }

            const body: Record<string, unknown> = {};
            if (opts.scopes && opts.scopes.length > 0) {
              body.requested_scopes = opts.scopes;
            }
            if (loopback) {
              body.redirect_after_connect = loopback.redirectUrl;
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

            if (loopback) {
              openInBrowser(result.connect_url);

              if (!jsonMode) {
                log.info(
                  `Opening browser to connect ${providerKey}. Waiting for authorization...`,
                );
              }

              // Wait for the platform to redirect back to our loopback server
              const callbackResult = await loopback.callbackPromise;

              if (callbackResult.status === "connected") {
                // Fetch the new connection details
                const currentEntries = await fetchActiveConnections(
                  client,
                  providerKey,
                  cmd,
                );
                // Best-effort: find the most recent connection
                const newest = currentEntries?.[currentEntries.length - 1];
                if (jsonMode) {
                  writeOutput(cmd, {
                    ok: true,
                    provider: providerKey,
                    connectionId: newest?.id ?? null,
                    accountLabel: newest?.account_label ?? null,
                    scopesGranted: newest?.scopes_granted ?? [],
                  });
                } else {
                  const label = newest?.account_label
                    ? ` as ${newest.account_label}`
                    : "";
                  process.stdout.write(`Connected to ${providerKey}${label}\n`);
                }
              } else {
                // Error or timeout
                const errorDetail = callbackResult.error ?? "unknown error";
                if (jsonMode) {
                  writeOutput(cmd, {
                    ok: false,
                    error: `OAuth connection failed: ${errorDetail}`,
                    provider: providerKey,
                  });
                } else {
                  writeError(`OAuth connection failed: ${errorDetail}`);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ManagedLoopbackResult {
  status: "connected" | "error" | "timeout";
  error?: string;
}

/**
 * Start a temporary loopback HTTP server that waits for the platform to
 * redirect back after managed OAuth completes. Returns the redirect URL
 * to pass as `redirect_after_connect` and a promise that resolves with
 * the callback result.
 */
function startManagedLoopbackServer(): Promise<{
  redirectUrl: string;
  callbackPromise: Promise<ManagedLoopbackResult>;
}> {
  return new Promise((resolveSetup, rejectSetup) => {
    const TIMEOUT_MS = 5 * 60 * 1000;
    let settled = false;
    let resultResolve: (result: ManagedLoopbackResult) => void;
    const callbackPromise = new Promise<ManagedLoopbackResult>((resolve) => {
      resultResolve = resolve;
    });

    const server = createServer((req, res) => {
      if (settled) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Already handled.");
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      settled = true;

      const oauthStatus = url.searchParams.get("oauth_status");
      const oauthCode = url.searchParams.get("oauth_code");

      if (oauthStatus === "connected") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(renderCallbackPage(true));
        cleanup();
        resultResolve({ status: "connected" });
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(renderCallbackPage(false, oauthCode ?? undefined));
        cleanup();
        resultResolve({
          status: "error",
          error: oauthCode ?? "OAuth connection failed",
        });
      }
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resultResolve({ status: "timeout", error: "Timed out waiting for authorization" });
      }
    }, TIMEOUT_MS);
    if (typeof timeout === "object" && "unref" in timeout) timeout.unref();

    function cleanup() {
      clearTimeout(timeout);
      server.close();
    }

    server.listen(0, "localhost", () => {
      const addr = server.address() as { port: number };
      const redirectUrl = `http://localhost:${addr.port}/oauth/callback`;
      resolveSetup({ redirectUrl, callbackPromise });
    });

    server.on("error", (err) => {
      if (!settled) {
        settled = true;
        cleanup();
        rejectSetup(
          new Error(`Failed to start loopback server: ${err.message}`),
        );
      }
    });
  });
}

function renderCallbackPage(success: boolean, errorCode?: string): string {
  const title = success ? "Authorization Successful" : "Authorization Failed";
  const color = success ? "#4CAF50" : "#f44336";
  const icon = success ? "✓" : "✗";
  const message = success
    ? "Your account has been connected. You can return to the app."
    : `Something went wrong${errorCode ? ` (${errorCode})` : ""}. Please return to the app and try again.`;
  return `<!DOCTYPE html>
<html><head>
<title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; color: #333; }
  .card { text-align: center; padding: 3rem 2.5rem; background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); max-width: 420px; }
  .icon { font-size: 3rem; width: 64px; height: 64px; line-height: 64px; border-radius: 50%; margin: 0 auto 1.5rem; background: ${color}18; color: ${color}; }
  h1 { color: ${color}; margin: 0 0 0.75rem; font-size: 1.5rem; }
  p { margin: 0; color: #666; line-height: 1.5; }
</style>
</head><body>
<div class="card">
  <div class="icon">${icon}</div>
  <h1>${title}</h1>
  <p>${message}</p>
</div>
</body></html>`;
}
