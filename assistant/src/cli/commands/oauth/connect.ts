import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { openInHostBrowser } from "../../lib/open-browser.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// IPC polling helpers
// ---------------------------------------------------------------------------

type OAuthConnectStatusResponse =
  | { status: "pending"; service: string }
  | {
      status: "complete";
      service: string;
      account_info?: string;
      granted_scopes?: string[];
    }
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
      return {
        status: "error",
        service: "?",
        error: r.error ?? "assistant error during OAuth status poll",
      };
    }
    await new Promise<void>((res) => setTimeout(res, opts.intervalMs));
  }
  return {
    status: "error",
    service: "?",
    error: "Timed out waiting for OAuth callback",
  };
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
          // 1. Validate provider exists via IPC
          // ---------------------------------------------------------------
          const providerCheck = await cliIpcCall<{
            provider: Record<string, unknown>;
          }>("oauth_providers_by_providerKey_get", {
            pathParams: { providerKey: provider },
          });

          if (!providerCheck.ok) {
            if (providerCheck.statusCode === 404) {
              writeError(
                `Unknown provider "${provider}". ` +
                  `Run 'assistant oauth providers list' to see available providers.`,
              );
              return;
            }
            return exitFromIpcResult(providerCheck);
          }

          const providerRow = providerCheck.result?.provider as
            | Record<string, unknown>
            | undefined;
          const authorizeUrl = providerRow?.authUrl as string | undefined;

          // ---------------------------------------------------------------
          // 2. Detect mode via IPC
          // ---------------------------------------------------------------
          const modeResult = await cliIpcCall<{
            ok: boolean;
            mode: string;
          }>("oauth_mode_get", {
            queryParams: { provider },
          });

          if (!modeResult.ok) return exitFromIpcResult(modeResult);

          const managed = modeResult.result?.mode === "managed";

          if (managed) {
            // =============================================================
            // MANAGED PATH
            // =============================================================

            if (opts.clientId) {
              log.info(
                `Warning: --client-id is ignored for platform-managed providers. The platform manages OAuth apps for "${provider}".`,
              );
            }

            const startBody: Record<string, unknown> = { provider };
            if (opts.scopes && opts.scopes.length > 0) {
              startBody.scopes = opts.scopes;
            }

            const startResult = await cliIpcCall<{
              ok: boolean;
              connect_url: string;
            }>("oauth_managed_connect_start", {
              body: startBody,
            });

            if (!startResult.ok) return exitFromIpcResult(startResult);

            const connectUrl = startResult.result!.connect_url;

            if (opts.browser !== false) {
              // Snapshot existing connection IDs before opening browser
              const snapshotResult = await cliIpcCall<{
                ok: boolean;
                connections: Array<{
                  id: string;
                  account_label?: string;
                  scopes_granted?: string[];
                }>;
              }>("oauth_managed_connect_poll", {
                queryParams: { provider },
              });

              if (!snapshotResult.ok) return exitFromIpcResult(snapshotResult);

              const snapshotIds = new Set(
                (snapshotResult.result?.connections ?? []).map((e) => e.id),
              );

              openInHostBrowser(connectUrl);

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

                const currentResult = await cliIpcCall<{
                  ok: boolean;
                  connections: Array<{
                    id: string;
                    account_label?: string;
                    scopes_granted?: string[];
                  }>;
                }>("oauth_managed_connect_poll", {
                  queryParams: { provider },
                });

                if (!currentResult.ok || !currentResult.result) continue;

                const found = currentResult.result.connections.find(
                  (e) => !snapshotIds.has(e.id),
                );
                if (found) {
                  newConnection = found;
                  break;
                }
              }

              if (newConnection) {
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
                if (jsonMode) {
                  writeOutput(cmd, {
                    ok: true,
                    deferred: true,
                    provider: provider,
                    connectUrl,
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
                  connectUrl,
                  provider: provider,
                });
              } else {
                process.stdout.write(connectUrl + "\n");
              }
            }
          } else {
            // =============================================================
            // BYO PATH
            // =============================================================

            // Manual-token providers don't use OAuth2 browser flows
            if (authorizeUrl === "urn:manual-token") {
              writeError(
                `"${provider}" uses manual token configuration, not an OAuth browser flow. ` +
                  `Set the token with: assistant credentials set <token_value> --service ${provider} --field <field_name>`,
              );
              return;
            }

            // Use daemon-orchestrated path via existing internal routes
            const startBody: Record<string, unknown> = {
              service: provider,
              callbackTransport: opts.callbackTransport,
            };
            if (opts.clientId) startBody.clientId = opts.clientId;
            if (opts.scopes) startBody.requestedScopes = opts.scopes;

            const startResult = await cliIpcCall<{
              auth_url: string;
              state: string;
            }>("internal_oauth_connect_start", {
              body: startBody,
            });

            if (startResult.ok && startResult.result?.auth_url) {
              const { auth_url, state } = startResult.result;

              if (opts.browser !== false) {
                openInHostBrowser(auth_url);

                if (!jsonMode) {
                  log.info(
                    "Waiting for authorization in browser... (press Ctrl+C to cancel)",
                  );
                }
                const final = await pollOAuthConnectStatus(state, {
                  intervalMs: 2000,
                  timeoutMs: 5 * 60 * 1000,
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
                  writeError(final.error ?? "OAuth connect failed");
                  return;
                }

                writeError(
                  "OAuth connect ended in an unexpected pending state",
                );
                return;
              } else {
                // --no-browser: return the URL immediately
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

            if (startResult.ok && !startResult.result?.auth_url) {
              writeError(
                "assistant returned unexpected response for OAuth connect start",
              );
              return;
            }

            if (!startResult.ok && startResult.statusCode !== undefined) {
              writeError(
                startResult.error ?? "OAuth connect failed (assistant error)",
              );
              return;
            }

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
