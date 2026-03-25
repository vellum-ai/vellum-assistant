import { localOAuthHandle } from "@vellumai/ces-contracts/handles";
import type { Command } from "commander";

import {
  fetchManagedCatalog,
  type ManagedCredentialDescriptor,
} from "../../../credential-execution/managed-catalog.js";
import {
  getConnection,
  getConnectionByProvider,
  getProvider,
  listConnections,
} from "../../../oauth/oauth-store.js";
import { withValidToken } from "../../../security/token-manager.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import { printDeprecationWarning } from "./shared.js";

// ---------------------------------------------------------------------------
// CES shell lockdown guard
// ---------------------------------------------------------------------------

/**
 * Returns true when the current process is running inside an untrusted shell
 * (CES shell lockdown active). CLI commands that reveal raw tokens must
 * check this and fail deterministically.
 */
function isUntrustedShell(): boolean {
  return process.env.VELLUM_UNTRUSTED_SHELL === "1";
}

/** Error message for commands blocked by CES shell lockdown. */
const UNTRUSTED_SHELL_ERROR =
  "This command is not available in untrusted shell mode. " +
  "Raw token access is restricted when running under CES shell lockdown.";

const log = getCliLogger("cli");

/**
 * Keys that may contain secrets in an OAuth token endpoint response.
 * These are stripped from the `metadata` field before CLI output to prevent
 * token leakage via shell history, logs, or agent transcript capture.
 */
const REDACTED_METADATA_KEYS = new Set([
  "access_token",
  "refresh_token",
  "id_token",
]);

/** Recursively strip secret-bearing keys from a parsed metadata object. */
function redactMetadata(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (REDACTED_METADATA_KEYS.has(key)) {
      result[key] = "[REDACTED]";
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? redactMetadata(item as Record<string, unknown>)
          : item,
      );
    } else if (value && typeof value === "object") {
      result[key] = redactMetadata(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Parse stored JSON string fields and convert timestamps for a connection row. */
function formatConnectionRow(row: ReturnType<typeof getConnection>) {
  if (!row) return row;
  const parsed = row.metadata ? JSON.parse(row.metadata) : null;
  return {
    ...row,
    handle: localOAuthHandle(row.providerKey, row.id),
    grantedScopes: row.grantedScopes ? JSON.parse(row.grantedScopes) : [],
    metadata: parsed ? redactMetadata(parsed) : null,
    hasRefreshToken: row.hasRefreshToken === 1,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
  };
}

/**
 * Format a platform-managed credential descriptor into a connection-like
 * output row. Never includes token values — only handle references and
 * non-secret metadata.
 */
function formatManagedConnectionRow(
  descriptor: ManagedCredentialDescriptor,
): Record<string, unknown> {
  return {
    source: "platform",
    handle: descriptor.handle,
    provider: descriptor.provider,
    connectionId: descriptor.connectionId,
    accountInfo: descriptor.accountInfo,
    grantedScopes: descriptor.grantedScopes,
    status: descriptor.status,
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
  $ assistant oauth connections list --provider integration:google
  $ assistant oauth connections list --client-id abc123
  $ assistant oauth connections get --id <uuid>
  $ assistant oauth connections get --provider integration:google
  $ assistant oauth connections get --provider integration:google --client-id abc123
  $ assistant oauth connections token integration:twitter
  $ assistant oauth connections ping integration:google`,
  );

  // ---------------------------------------------------------------------------
  // connections list
  // ---------------------------------------------------------------------------

  connections
    .command("list")
    .description("List all OAuth connections")
    .option(
      "--provider <key>",
      "Filter by provider key (e.g. integration:google)",
    )
    .option("--client-id <id>", "Filter by OAuth client ID")
    .addHelpText(
      "after",
      `
Lists all OAuth connections, optionally filtered by provider key and/or client ID.

Each connection shows its ID, provider, account info, granted scopes, token
expiry, refresh token availability, and status.

Examples:
  $ assistant oauth connections list
  $ assistant oauth connections list --provider integration:google
  $ assistant oauth connections list --client-id abc123`,
    )
    .action(
      async (opts: { provider?: string; clientId?: string }, cmd: Command) => {
        try {
          const rows = listConnections(opts.provider, opts.clientId).map(
            formatConnectionRow,
          );

          // Fetch platform-managed connections (best-effort — errors do not
          // break local listing).
          const managedResult = await fetchManagedCatalog();
          let managedEntries: Array<Record<string, unknown>> = [];
          if (managedResult.ok && managedResult.descriptors.length > 0) {
            let descriptors = managedResult.descriptors;
            // Apply provider filter if specified.  Managed descriptors use
            // plain slugs (e.g. "google") while the CLI --provider flag uses
            // the canonical "integration:google" format.  Strip the prefix
            // before comparing so both forms match.
            if (opts.provider) {
              const filterKey = opts.provider
                .replace(/^integration:/, "")
                .toLowerCase();
              descriptors = descriptors.filter(
                (d) => d.provider.toLowerCase() === filterKey,
              );
            }
            managedEntries = descriptors.map(formatManagedConnectionRow);
          }

          if (!shouldOutputJson(cmd)) {
            log.info(
              `Found ${rows.length} local connection(s)` +
                (managedEntries.length > 0
                  ? `, ${managedEntries.length} platform-managed`
                  : ""),
            );
          }

          writeOutput(cmd, {
            connections: rows,
            managedConnections: managedEntries,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );

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
    .option(
      "--client-id <id>",
      "Filter by OAuth client ID (used with --provider)",
    )
    .addHelpText(
      "after",
      `
Two lookup modes are supported:

  1. By connection ID:
     $ assistant oauth connections get --id <uuid>

  2. By provider (returns the most recent active connection):
     $ assistant oauth connections get --provider integration:google
     $ assistant oauth connections get --provider integration:google --client-id abc123

At least --id or --provider must be specified.`,
    )
    .action(
      (
        opts: { id?: string; provider?: string; clientId?: string },
        cmd: Command,
      ) => {
        try {
          let row;

          if (opts.id) {
            row = getConnection(opts.id);
          } else if (opts.provider) {
            row = getConnectionByProvider(opts.provider, opts.clientId);
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
      },
    );

  // ---------------------------------------------------------------------------
  // connections token <provider-key>
  // ---------------------------------------------------------------------------

  connections
    .command("token <provider-key>", { hidden: true })
    .description(
      "Print a valid OAuth access token for a provider, refreshing if expired",
    )
    .option(
      "--client-id <id>",
      "Filter by OAuth client ID when multiple apps exist for the provider",
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider-key   Provider key (e.g. integration:google, integration:twitter)

Returns a valid OAuth access token for the given provider. If the stored token
is expired or near-expiry, it is refreshed automatically before being returned.

In human mode, prints the bare token to stdout (suitable for shell substitution).
In JSON mode (--json), prints {"ok": true, "token": "..."}.

Exits with code 1 if no access token exists or refresh fails.

Examples:
  $ assistant oauth connections token integration:twitter
  $ assistant oauth connections token integration:google --json
  $ assistant oauth connections token integration:google --client-id abc123`,
    )
    .action(
      async (
        providerKey: string,
        opts: { clientId?: string },
        cmd: Command,
      ) => {
        try {
          printDeprecationWarning(
            "assistant oauth connections token",
            "assistant oauth token",
            cmd,
          );

          // CES shell lockdown: deny raw token reveal in untrusted shells.
          if (isUntrustedShell()) {
            writeOutput(cmd, { ok: false, error: UNTRUSTED_SHELL_ERROR });
            process.exitCode = 1;
            return;
          }

          const token = await withValidToken(
            providerKey,
            async (t) => t,
            opts.clientId,
          );
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
      },
    );

  // ---------------------------------------------------------------------------
  // connections ping <provider-key>
  // ---------------------------------------------------------------------------

  connections
    .command("ping <provider-key>", { hidden: true })
    .description(
      "Verify that a stored OAuth token is still valid by hitting the provider's health-check endpoint",
    )
    .option(
      "--client-id <id>",
      "Filter by OAuth client ID when multiple apps exist for the provider",
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider-key   Provider key (e.g. integration:google, integration:twitter)

Fetches a valid access token (refreshing if needed) and sends a GET request
to the provider's configured ping URL. Reports success (HTTP 2xx) or failure.

The ping URL is set per-provider in seed data or via "providers register --ping-url".
If no ping URL is configured for the provider, exits with an error.

Examples:
  $ assistant oauth connections ping integration:google
  $ assistant oauth connections ping integration:twitter --json
  $ assistant oauth connections ping integration:google --client-id abc123`,
    )
    .action(
      async (
        providerKey: string,
        opts: { clientId?: string },
        cmd: Command,
      ) => {
        try {
          printDeprecationWarning("oauth connections ping", "oauth ping", cmd);

          const provider = getProvider(providerKey);
          if (!provider) {
            writeOutput(cmd, {
              ok: false,
              error: `Provider not found: ${providerKey}`,
            });
            process.exitCode = 1;
            return;
          }

          if (!provider.pingUrl) {
            writeOutput(cmd, {
              ok: false,
              error: `No ping URL configured for "${providerKey}"`,
            });
            process.exitCode = 1;
            return;
          }

          const pingUrl = provider.pingUrl;

          const PING_TIMEOUT_MS = 15_000;

          const result = await withValidToken(
            providerKey,
            async (token) => {
              const controller = new AbortController();
              const timer = setTimeout(
                () => controller.abort(),
                PING_TIMEOUT_MS,
              );
              try {
                const res = await fetch(pingUrl, {
                  method: "GET",
                  headers: { Authorization: `Bearer ${token}` },
                  signal: controller.signal,
                });

                if (res.status === 401) {
                  const err = new Error(
                    `Ping returned HTTP 401 from ${pingUrl}`,
                  );
                  (err as unknown as { status: number }).status = 401;
                  throw err;
                }

                return { status: res.status, ok: res.ok };
              } finally {
                clearTimeout(timer);
              }
            },
            opts.clientId,
          );

          if (result.ok) {
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, {
                ok: true,
                provider: providerKey,
                status: result.status,
              });
            } else {
              log.info(`${providerKey}: OK (HTTP ${result.status})`);
              writeOutput(cmd, {
                ok: true,
                provider: providerKey,
                status: result.status,
              });
            }
          } else {
            writeOutput(cmd, {
              ok: false,
              provider: providerKey,
              status: result.status,
              error: `Ping failed with HTTP ${result.status}`,
            });
            process.exitCode = 1;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );
}
