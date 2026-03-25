import { localOAuthHandle } from "@vellumai/ces-contracts/handles";
import type { Command } from "commander";

import {
  fetchManagedCatalog,
  type ManagedCredentialDescriptor,
} from "../../../credential-execution/managed-catalog.js";
import {
  getConnection,
  getConnectionByProvider,
  listConnections,
} from "../../../oauth/oauth-store.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

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
  $ assistant oauth connections get --provider integration:google --client-id abc123`,
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
    .option(
      "--id <id>",
      "Connection ID (UUID) from 'assistant oauth connections list' or 'assistant oauth status <provider>'",
    )
    .option(
      "--provider <key>",
      "Provider key (e.g. integration:google) from 'assistant oauth providers list'. Returns most recent active connection.",
    )
    .option(
      "--client-id <id>",
      "Filter by OAuth client ID (used with --provider). Find IDs via 'assistant oauth apps list'.",
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
              error:
                "Provide --id or --provider. Run 'assistant oauth connections list' to see all connections, or 'assistant oauth status <provider>' to find connection IDs for a specific provider.",
            });
            process.exitCode = 1;
            return;
          }

          if (!row) {
            const source = opts.id
              ? `--id ${opts.id}`
              : `--provider ${opts.provider}`;
            writeOutput(cmd, {
              ok: false,
              error: `No connection found for ${source}. Run 'assistant oauth connections list' to see all connections, or 'assistant oauth connect <provider>' to create a new connection.`,
            });
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
}
