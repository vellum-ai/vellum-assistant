import type { Command } from "commander";

import { getProvider, listConnections } from "../../../oauth/oauth-store.js";
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

export function registerStatusCommand(oauth: Command): void {
  oauth
    .command("status <provider>")
    .description("Show OAuth connection status for a specified provider")
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name (e.g. google, slack).
             Run 'assistant oauth providers list' to see all available providers.

The output includes connection IDs and account identifiers that can be used
as inputs to other commands:
  - 'assistant oauth disconnect <provider>' to remove a connection
  - 'assistant oauth request --provider <provider> --account <account>' to
    make authenticated requests as a specific account

Examples:
  $ assistant oauth status google
  $ assistant oauth status google --json`,
    )
    .action(
      async (
        provider: string,
        _opts: Record<string, unknown>,
        cmd: Command,
      ) => {
        try {
          // -----------------------------------------------------------------
          // Validate provider
          // -----------------------------------------------------------------
          const providerRow = getProvider(provider);

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

          // -----------------------------------------------------------------
          // Detect mode
          // -----------------------------------------------------------------
          const managed = isManagedMode(provider);

          if (managed) {
            // ---------------------------------------------------------------
            // Managed path
            // ---------------------------------------------------------------
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
              account: c.account_label ?? null,
              grantedScopes: c.scopes_granted ?? [],
              status: c.status ?? "ACTIVE",
            }));

            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, {
                ok: true,
                provider: provider,
                mode: "managed",
                connections,
              });
              return;
            }

            // Human output
            if (connections.length === 0) {
              log.info(
                `No active connections for ${provider}. Connect with 'assistant oauth connect ${provider}'.`,
              );
              return;
            }

            log.info(`Provider: ${provider} (managed)`);
            log.info(`${connections.length} active connection(s):`);
            for (const c of connections) {
              const scopes =
                c.grantedScopes.length > 0
                  ? `[${c.grantedScopes.join(", ")}]`
                  : "[]";
              log.info(
                `  \u2022 ${c.id}  ${c.account ?? "(no account)"}  ${scopes}  ${c.status}`,
              );
            }
          } else {
            // ---------------------------------------------------------------
            // BYO path
            // ---------------------------------------------------------------
            const allConnections = listConnections(provider);
            const activeRows = allConnections.filter(
              (r) => r.status === "active",
            );

            const connections = activeRows.map((r) => {
              let grantedScopes: string[] = [];
              try {
                grantedScopes = r.grantedScopes
                  ? JSON.parse(r.grantedScopes)
                  : [];
              } catch {
                // Malformed JSON — default to empty
              }

              return {
                id: r.id,
                account: r.accountInfo ?? null,
                grantedScopes,
                expiresAt: r.expiresAt
                  ? new Date(r.expiresAt).toISOString()
                  : null,
                hasRefreshToken: r.hasRefreshToken === 1,
                status: r.status,
              };
            });

            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, {
                ok: true,
                provider: provider,
                mode: "byo",
                connections,
              });
              return;
            }

            // Human output
            if (connections.length === 0) {
              log.info(
                `No active connections for ${provider}. Connect with 'assistant oauth connect ${provider}'.`,
              );
              return;
            }

            log.info(`Provider: ${provider} (byo)`);
            log.info(`${connections.length} active connection(s):`);
            for (const c of connections) {
              const scopes =
                c.grantedScopes.length > 0
                  ? `[${c.grantedScopes.join(", ")}]`
                  : "[]";
              const expires = c.expiresAt
                ? `expires ${c.expiresAt}`
                : "no expiry";
              const refresh = c.hasRefreshToken
                ? "refresh: yes"
                : "refresh: no";
              log.info(
                `  \u2022 ${c.id}  ${c.account ?? "(no account)"}  ${scopes}  ${expires}  ${refresh}`,
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
