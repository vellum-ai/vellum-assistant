import type { Command } from "commander";

import {
  resolveOAuthConnection,
  type ResolveOAuthConnectionOptions,
} from "../../../oauth/connection-resolver.js";
import { getProvider } from "../../../oauth/oauth-store.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import { resolveService } from "./shared.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPingCommand(oauth: Command): void {
  oauth
    .command("ping <provider>")
    .description(
      "Verify an OAuth token is valid by hitting the provider's configured health-check endpoint",
    )
    .option("--account <account>", "Account identifier for multi-account")
    .option("--client-id <id>", "BYO app client ID disambiguation")
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name (e.g. google, slack).
             Run 'assistant oauth providers list' to see available providers.

Options:
  --account <account>   Account identifier (e.g. email) to disambiguate when
                        multiple accounts are connected for the same provider.
  --client-id <id>      BYO-only: select a specific OAuth app when multiple
                        apps exist for the same provider. Ignored for
                        platform-managed providers.

Examples:
  $ assistant oauth ping google
  $ assistant oauth ping google --json
  $ assistant oauth ping google --account user@example.com`,
    )
    .action(
      async (
        provider: string,
        opts: {
          account?: string;
          clientId?: string;
        },
        cmd: Command,
      ) => {
        const jsonMode = shouldOutputJson(cmd);

        try {
          // -----------------------------------------------------------------
          // 1. Resolve provider key
          // -----------------------------------------------------------------
          const providerKey = resolveService(provider);

          // -----------------------------------------------------------------
          // 2. Validate provider exists
          // -----------------------------------------------------------------
          const providerRow = getProvider(providerKey);
          if (!providerRow) {
            writeOutput(cmd, {
              ok: false,
              error:
                `Unknown provider "${providerKey}". ` +
                `Run 'assistant oauth providers list' to see available providers.`,
            });
            process.exitCode = 1;
            return;
          }

          // -----------------------------------------------------------------
          // 3. Validate ping URL
          // -----------------------------------------------------------------
          if (!providerRow.pingUrl) {
            writeOutput(cmd, {
              ok: false,
              error:
                `No ping URL configured for "${providerKey}". ` +
                `Register one with 'assistant oauth providers register --ping-url <url>'.`,
            });
            process.exitCode = 1;
            return;
          }

          const pingUrl = providerRow.pingUrl as string;
          const parsed = new URL(pingUrl);
          const baseUrl = `${parsed.protocol}//${parsed.host}`;
          const path = parsed.pathname;

          // Preserve query parameters from the configured ping URL
          const query: Record<string, string> = {};
          for (const [key, value] of parsed.searchParams) {
            query[key] = value;
          }

          // -----------------------------------------------------------------
          // 4. Resolve connection (auto-detects managed vs BYO)
          // -----------------------------------------------------------------
          const resolveOptions: ResolveOAuthConnectionOptions = {};
          if (opts.account) {
            resolveOptions.account = opts.account;
          }
          if (opts.clientId) {
            resolveOptions.clientId = opts.clientId;
          }

          let connection;
          try {
            connection = await resolveOAuthConnection(
              providerKey,
              resolveOptions,
            );
          } catch (resolveErr) {
            const resolveMessage =
              resolveErr instanceof Error
                ? resolveErr.message
                : String(resolveErr);

            writeOutput(cmd, {
              ok: false,
              error: resolveMessage,
              hint:
                `Run 'assistant oauth status ${providerKey}' to check connection health. ` +
                `To reconnect, run 'assistant oauth connect --help'.`,
            });
            process.exitCode = 1;
            return;
          }

          // -----------------------------------------------------------------
          // 5. Make the ping request
          // -----------------------------------------------------------------
          const method = (providerRow.pingMethod as string | null) ?? "GET";

          // Parse provider-configured ping headers (JSON string -> Record)
          const pingHeaders: Record<string, string> = providerRow.pingHeaders
            ? JSON.parse(providerRow.pingHeaders as string)
            : {};

          // Parse provider-configured ping body (JSON string -> unknown)
          const pingBody: unknown = providerRow.pingBody
            ? JSON.parse(providerRow.pingBody as string)
            : undefined;

          const response = await connection.request({
            method,
            path,
            baseUrl,
            ...(Object.keys(query).length > 0 ? { query } : {}),
            ...(Object.keys(pingHeaders).length > 0
              ? { headers: pingHeaders }
              : {}),
            ...(pingBody !== undefined ? { body: pingBody } : {}),
          });

          // -----------------------------------------------------------------
          // 6. Handle response
          // -----------------------------------------------------------------
          if (response.status >= 200 && response.status < 300) {
            // Success
            if (!jsonMode) {
              log.info(`${providerKey}: OK (HTTP ${response.status})`);
            }
            writeOutput(cmd, {
              ok: true,
              provider: providerKey,
              status: response.status,
            });
          } else {
            // Non-2xx failure
            const payload: Record<string, unknown> = {
              ok: false,
              provider: providerKey,
              status: response.status,
              error: `Ping failed with HTTP ${response.status}`,
            };

            if (response.status === 401 || response.status === 403) {
              payload.hint =
                `Run 'assistant oauth status ${providerKey}' to check connection health. ` +
                `To reconnect, run 'assistant oauth connect --help'.`;
            }

            writeOutput(cmd, payload);
            process.exitCode = 1;
          }
        } catch (err) {
          // Network failure or other unexpected error
          const message = err instanceof Error ? err.message : String(err);

          // Try to extract providerKey for recovery hints
          let providerKey: string;
          try {
            providerKey = resolveService(provider);
          } catch {
            providerKey = provider;
          }

          writeOutput(cmd, {
            ok: false,
            error: message,
            hint:
              `Run 'assistant oauth status ${providerKey}' to check connection health. ` +
              `To reconnect, run 'assistant oauth connect --help'.`,
          });
          process.exitCode = 1;
        }
      },
    );
}
