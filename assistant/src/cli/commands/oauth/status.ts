import type { Command } from "commander";

import { getProvider, listConnections } from "../../../oauth/oauth-store.js";
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

export function registerStatusCommand(oauth: Command): void {
  oauth
    .command("status <provider>")
    .description(
      "Show OAuth connection status for a provider (auto-detects managed vs BYO mode)",
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name or key. Accepts bare names (google, slack),
             canonical keys (integration:google), or aliases (gmail).
             Run 'assistant oauth providers list' to see all available providers.

The output includes connection IDs and account identifiers that can be used
as inputs to other commands:
  - 'assistant oauth disconnect <provider>' to remove a connection
  - 'assistant oauth request --provider <provider> --account <account>' to
    make authenticated requests as a specific account

Mode detection:
  The command automatically detects whether the provider is configured in
  platform-managed mode or bring-your-own (BYO) mode based on the assistant's
  services config. Managed mode delegates OAuth to the Vellum platform; BYO
  mode uses locally stored tokens.

Examples:
  $ assistant oauth status google
  $ assistant oauth status integration:google --json`,
    )
    .action(
      async (
        provider: string,
        _opts: Record<string, unknown>,
        cmd: Command,
      ) => {
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

          // -----------------------------------------------------------------
          // Detect mode
          // -----------------------------------------------------------------
          const managed = isManagedMode(providerKey);

          if (managed) {
            // ---------------------------------------------------------------
            // Managed path
            // ---------------------------------------------------------------
            const client = await requirePlatformClient(cmd);
            if (!client) return;

            const rawEntries = await fetchActiveConnections(
              client,
              providerKey,
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
                provider: providerKey,
                mode: "managed",
                connections,
              });
              return;
            }

            // Human output
            if (connections.length === 0) {
              log.info(
                `No active connections for ${providerKey}. Connect with 'assistant oauth connect ${providerKey}'.`,
              );
              return;
            }

            log.info(`Provider: ${providerKey} (managed)`);
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
            const allConnections = listConnections(providerKey);
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
                provider: providerKey,
                mode: "byo",
                connections,
              });
              return;
            }

            // Human output
            if (connections.length === 0) {
              log.info(
                `No active connections for ${providerKey}. Connect with 'assistant oauth connect ${providerKey}'.`,
              );
              return;
            }

            log.info(`Provider: ${providerKey} (byo)`);
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
