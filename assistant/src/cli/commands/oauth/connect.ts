import { createServer, type Server } from "node:http";

import type { Command } from "commander";

import { getIsContainerized } from "../../../config/env-registry.js";
import { cliIpcCall } from "../../../ipc/cli-client.js";
import {
  getAppByProviderAndClientId,
  getMostRecentAppByProvider,
  getProvider,
} from "../../../oauth/oauth-store.js";
import { renderOAuthCompletionPage } from "../../../security/oauth-completion-page.js";
import { getSecureKeyAsync } from "../../../security/secure-keys.js";
import { openInHostBrowser } from "../../../util/browser.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import {
  fetchActiveConnections,
  isManagedMode,
  requirePlatformClient,
} from "./shared.js";

const log = getCliLogger("cli");

/**
 * Start a temporary loopback server to serve a nice completion page after the
 * platform redirects the user's browser following a managed OAuth flow.
 * Returns the base URL and a cleanup function.
 */
function startManagedRedirectServer(provider: string): Promise<{
  redirectUrl: string;
  cleanup: () => void;
}> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const error = url.searchParams.get("error");
      const errorDesc = url.searchParams.get("error_description");
      const providerHint = url.searchParams.get("provider") ?? provider;

      if (error) {
        const message = errorDesc ?? error;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(renderOAuthCompletionPage(message, false, providerHint));
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          renderOAuthCompletionPage(
            "You can close this tab and return to your assistant.",
            true,
            providerHint,
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
// IPC polling helpers
// ---------------------------------------------------------------------------

type OAuthConnectStatusResponse =
  | { status: "pending"; service: string }
  | { status: "complete"; service: string; account_info?: string; granted_scopes?: string[] }
  | { status: "error"; service: string; error?: string };

async function pollOAuthConnectStatus(
  state: string,
  opts: { intervalMs: number; timeoutMs: number },
): Promise<OAuthConnectStatusResponse> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const r = await cliIpcCall<OAuthConnectStatusResponse>(
      "internal_oauth_connect_status",
      { pathParams: { state } },
    );
    if (r.ok && r.result) {
      const { status } = r.result;
      if (status === "complete" || status === "error") {
        return r.result;
      }
    }
    if (!r.ok && r.statusCode !== undefined) {
      return { status: "error", service: "?", error: r.error ?? "assistant error during OAuth status poll" };
    }
    await new Promise<void>((res) => setTimeout(res, opts.intervalMs));
  }
  return { status: "error", service: "?", error: "Timed out waiting for OAuth callback" };
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
      "--no-browser",
      "Print the auth URL instead of opening it in the browser",
    )
    .option("--client-id <id>", "BYO app client ID disambiguation")
    .option(
      "--callback-transport <transport>",
      `How the OAuth callback is delivered after authorization. Use "loopback" when oauth connection is initiated from a local client, such as the macos desktop app (starts a temporary localhost server to receive the callback — no tunnel or public URL needed). Use "gateway" when the oauth connection is initiated from a web client (routes the callback through the public ingress URL — requires ingress.publicBaseUrl to be configured).`,
      "loopback",
    )
    .hook("preAction", (thisCommand) => {
      const transport = thisCommand.opts().callbackTransport;
      if (transport !== "loopback" && transport !== "gateway") {
        thisCommand.error(
          `Invalid --callback-transport value "${transport}". Must be "loopback" or "gateway".`,
        );
      }
    })
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name (e.g. google, slack, notion).
             Run 'assistant oauth providers list' to see available providers.

When --scopes is provided, the specified scopes replace the provider's
defaults entirely (use full scope URLs).
By default, the browser opens automatically and the command waits for
completion. Use --no-browser to print the URL instead (useful for headless
or SSH sessions).

Examples:
  $ assistant oauth connect google
  $ assistant oauth connect google --no-browser
  $ assistant oauth connect google --scopes https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events
  $ assistant oauth connect google --client-id abc123`,
    )
    .action(
      async (
        provider: string,
        opts: {
          scopes?: string[];
          browser?: boolean;
          clientId?: string;
          callbackTransport: "loopback" | "gateway";
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

            // When opening the browser, start a local server to show a nice
            // completion page instead of redirecting to the platform website.
            //
            // In containerized mode the loopback server is unreachable from
            // the host browser, so redirect to the platform's own completion
            // page instead.
            let redirectServer:
              | { redirectUrl: string; cleanup: () => void }
              | undefined;
            if (opts.browser !== false) {
              if (getIsContainerized()) {
                body.redirect_after_connect = "/account/oauth/desktop-complete";
              } else {
                try {
                  redirectServer = await startManagedRedirectServer(provider);
                  body.redirect_after_connect = redirectServer.redirectUrl;
                } catch {
                  // Non-fatal — fall back to platform default redirect
                }
              }
            }

            try {
              const response = await client.fetch(startPath, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              });

              if (!response.ok) {
                const errorText = await response.text().catch(() => "");
                const baseMsg = `Platform returned HTTP ${response.status}${errorText ? `: ${errorText}` : ""}`;
                if (response.status === 401 || response.status === 403) {
                  writeError(
                    `${baseMsg}. Your platform session may have expired. Run \`vellum platform connect\` to reconnect.`,
                  );
                } else {
                  writeError(baseMsg);
                }
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

              if (opts.browser !== false) {
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

                await openInHostBrowser(result.connect_url);

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
                // --no-browser: output the connect URL
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
            } finally {
              redirectServer?.cleanup();
            }
          } else {
            // =============================================================
            // BYO PATH
            // =============================================================

            // Manual-token providers (slack_channel, telegram) don't use
            // OAuth2 browser flows — credentials are configured via
            // `assistant credentials` or chat setup instead.
            if (providerRow.authorizeUrl === "urn:manual-token") {
              writeError(
                `"${provider}" uses manual token configuration, not an OAuth browser flow. ` +
                  `Set the token with: assistant credentials set <token_value> --service ${provider} --field <field_name>`,
              );
              return;
            }

            // a. Resolve client credentials from the DB
            const dbApp = opts.clientId
              ? getAppByProviderAndClientId(provider, opts.clientId)
              : getMostRecentAppByProvider(provider);

            let clientId = opts.clientId;
            let clientSecret: string | undefined;

            if (dbApp) {
              if (!clientId) clientId = dbApp.clientId;
              const storedSecret = await getSecureKeyAsync(
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
              const requiresSecret = !!providerRow?.requiresClientSecret;

              if (requiresSecret) {
                writeError(
                  `client_secret is required for ${provider} but not found. ` +
                    `Store it with 'assistant oauth apps upsert --client-secret'.`,
                );
                return;
              }
            }

            // e. Try daemon-orchestrated path first (fixes heap-split for gateway transport).
            const startResult = await cliIpcCall<{ auth_url: string; state: string }>(
              "internal_oauth_connect_start",
              {
                body: {
                  service: provider,
                  clientId,
                  ...(clientSecret !== undefined ? { clientSecret } : {}),
                  callbackTransport: opts.callbackTransport,
                  ...(opts.scopes ? { requestedScopes: opts.scopes } : {}),
                },
              },
            );

            if (startResult.ok && startResult.result?.auth_url) {
              const { auth_url, state } = startResult.result;

              if (opts.browser !== false) {
                await openInHostBrowser(auth_url);

                if (!jsonMode) {
                  log.info("Waiting for authorization in browser... (press Ctrl+C to cancel)");
                }
                const final = await pollOAuthConnectStatus(state, {
                  intervalMs: 2000,
                  timeoutMs: 5 * 60 * 1000, // match LOOPBACK_TIMEOUT_MS in oauth2.ts (5 min)
                });

                if (final.status === "complete") {
                  if (jsonMode) {
                    writeOutput(cmd, {
                      ok: true,
                      grantedScopes: final.granted_scopes ?? [],
                      accountInfo: final.account_info,
                    });
                  } else {
                    process.stdout.write(
                      `Connected to ${provider}${final.account_info ? ` as ${final.account_info}` : ""}\n`,
                    );
                  }
                  return;
                }

                if (final.status === "error") {
                  // Includes the timeout sentinel emitted by pollOAuthConnectStatus.
                  writeError(final.error ?? "OAuth connect failed");
                  return;
                }

                // Defensive: pollOAuthConnectStatus should never return pending,
                // but TS narrowing requires us to handle it.
                writeError("OAuth connect ended in an unexpected pending state");
                return;
              } else {
                // --no-browser: return the URL immediately, matching existing deferred behavior.
                if (jsonMode) {
                  writeOutput(cmd, {
                    ok: true,
                    deferred: true,
                    authUrl: auth_url,
                    state,
                    service: provider,
                  });
                } else {
                  process.stdout.write(
                    `\nAuthorize with ${provider}:\n\n${auth_url}\n\nThe connection will complete automatically once you authorize.\n`,
                  );
                }
                return;
              }
            }

            // ok:true but no auth_url means a malformed daemon response — surface an error rather
            // than falling back to in-process (which would re-introduce the heap-split bug for
            // gateway transport).
            if (startResult.ok && !startResult.result?.auth_url) {
              writeError("assistant returned unexpected response for OAuth connect start");
              return;
            }

            // If the daemon was reachable but returned an error, surface it rather than
            // falling back to in-process (which would re-introduce the heap-split bug for
            // gateway transport).
            if (!startResult.ok && startResult.statusCode !== undefined) {
              writeError(startResult.error ?? "OAuth connect failed (assistant error)");
              return;
            }

            // IPC unavailable: the assistant must be running for OAuth connect. The
            // gateway-routed callback lands in the assistant's process, and any tokens
            // acquired need the assistant to store and use them — so an unreachable
            // assistant is a fatal precondition. Surface a clear error and exit 1.
            writeError(
              startResult.error
                ? `Could not reach the assistant: ${startResult.error}. Is the assistant running?`
                : "Could not reach the assistant. Is the assistant running?",
            );
            return;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(message);
        }
      },
    );
}
