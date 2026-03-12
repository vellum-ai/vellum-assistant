import type { Command } from "commander";

import {
  getConnection,
  getConnectionByProvider,
  listConnections,
} from "../../../oauth/oauth-store.js";
import { withValidToken } from "../../../security/token-manager.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

/** Parse stored JSON string fields and convert timestamps for a connection row. */
function formatConnectionRow(row: ReturnType<typeof getConnection>) {
  if (!row) return row;
  return {
    ...row,
    grantedScopes: row.grantedScopes ? JSON.parse(row.grantedScopes) : [],
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    hasRefreshToken: row.hasRefreshToken === 1,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
  };
}

export function registerConnectionCommands(oauth: Command): void {
  const connections = oauth
    .command("connections")
    .description("Manage OAuth connections (active tokens and refresh state)");

  connections.addHelpText(
    "after",
    `
Connections represent active OAuth sessions — an access token bound to a
provider through an app registration. Each connection tracks granted scopes,
token expiry, refresh token availability, account info, and status.

Examples:
  $ assistant oauth connections list
  $ assistant oauth connections list --provider integration:gmail
  $ assistant oauth connections get --id <uuid>
  $ assistant oauth connections get --provider integration:gmail
  $ assistant oauth connections token integration:twitter`,
  );

  // ---------------------------------------------------------------------------
  // connections list
  // ---------------------------------------------------------------------------

  connections
    .command("list")
    .description("List all OAuth connections")
    .option(
      "--provider <key>",
      "Filter by provider key (e.g. integration:gmail)",
    )
    .addHelpText(
      "after",
      `
Lists all OAuth connections, optionally filtered by provider key.

Each connection shows its ID, provider, account info, granted scopes, token
expiry, refresh token availability, and status.

Examples:
  $ assistant oauth connections list
  $ assistant oauth connections list --provider integration:gmail`,
    )
    .action((opts: { provider?: string }, cmd: Command) => {
      try {
        const rows = listConnections(opts.provider).map(formatConnectionRow);

        if (!shouldOutputJson(cmd)) {
          log.info(`Found ${rows.length} connection(s)`);
        }

        writeOutput(cmd, rows);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // connections get
  // ---------------------------------------------------------------------------

  connections
    .command("get")
    .description("Look up an OAuth connection by ID or provider")
    .option("--id <id>", "Connection ID (UUID)")
    .option(
      "--provider <key>",
      "Provider key (returns most recent active connection)",
    )
    .addHelpText(
      "after",
      `
Two lookup modes are supported:

  1. By connection ID:
     $ assistant oauth connections get --id <uuid>

  2. By provider (returns the most recent active connection):
     $ assistant oauth connections get --provider integration:gmail

At least --id or --provider must be specified.`,
    )
    .action((opts: { id?: string; provider?: string }, cmd: Command) => {
      try {
        let row;

        if (opts.id) {
          row = getConnection(opts.id);
        } else if (opts.provider) {
          row = getConnectionByProvider(opts.provider);
        } else {
          writeOutput(cmd, {
            ok: false,
            error: "Provide --id or --provider",
          });
          process.exitCode = 1;
          return;
        }

        if (!row) {
          writeOutput(cmd, { ok: false, error: "Connection not found" });
          process.exitCode = 1;
          return;
        }

        writeOutput(cmd, formatConnectionRow(row));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // connections token <provider-key>
  // ---------------------------------------------------------------------------

  connections
    .command("token <provider-key>")
    .description(
      "Print a valid OAuth access token for a provider, refreshing if expired",
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider-key   Provider key (e.g. integration:gmail, integration:twitter)

Returns a valid OAuth access token for the given provider. If the stored token
is expired or near-expiry, it is refreshed automatically before being returned.

In human mode, prints the bare token to stdout (suitable for shell substitution).
In JSON mode (--json), prints {"ok": true, "token": "..."}.

Exits with code 1 if no access token exists or refresh fails.

Examples:
  $ assistant oauth connections token integration:twitter
  $ assistant oauth connections token integration:gmail --json`,
    )
    .action(async (providerKey: string, _opts: unknown, cmd: Command) => {
      try {
        const token = await withValidToken(providerKey, async (t) => t);
        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, { ok: true, token });
        } else {
          process.stdout.write(token + "\n");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });
}
