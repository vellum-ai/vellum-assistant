import type { Command } from "commander";

import { orchestrateOAuthConnect } from "../../../oauth/connect-orchestrator.js";
import {
  disconnectOAuthProvider,
  getAppByProviderAndClientId,
  getConnection,
  getConnectionByProvider,
  getMostRecentAppByProvider,
  getProvider,
  listConnections,
} from "../../../oauth/oauth-store.js";
import {
  getProviderBehavior,
  resolveService,
} from "../../../oauth/provider-behaviors.js";
import { credentialKey } from "../../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  getSecureKey,
} from "../../../security/secure-keys.js";
import { withValidToken } from "../../../security/token-manager.js";
import {
  assertMetadataWritable,
  deleteCredentialMetadata,
} from "../../../tools/credentials/metadata-store.js";
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
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
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
    grantedScopes: row.grantedScopes ? JSON.parse(row.grantedScopes) : [],
    metadata: parsed ? redactMetadata(parsed) : null,
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

  // ---------------------------------------------------------------------------
  // connections disconnect <provider-key>
  // ---------------------------------------------------------------------------

  connections
    .command("disconnect <provider-key>")
    .description(
      "Disconnect an OAuth integration and remove all associated credentials",
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider-key   The full provider key (e.g. integration:gmail, integration:slack)

Removes the OAuth connection, tokens, and any legacy credential metadata for
the provider. The <provider-key> argument is the full provider key as-is — it
is not parsed through service:field splitting.

Legacy credential keys for common fields (access_token, refresh_token,
client_id, client_secret) are also cleaned up if present.

Examples:
  $ assistant oauth connections disconnect integration:gmail
  $ assistant oauth connections disconnect integration:slack`,
    )
    .action(async (providerKey: string, _opts: unknown, cmd: Command) => {
      try {
        assertMetadataWritable();

        let cleanedUp = false;

        // 1. Disconnect the OAuth connection (new-format keys + connection row)
        const oauthResult = await disconnectOAuthProvider(providerKey);
        if (oauthResult === "error") {
          writeOutput(cmd, {
            ok: false,
            error: `Failed to disconnect OAuth provider "${providerKey}" — please try again`,
          });
          process.exitCode = 1;
          return;
        }
        if (oauthResult === "disconnected") cleanedUp = true;

        // 2. Clean up legacy credential keys for common fields
        const legacyFields = [
          "access_token",
          "refresh_token",
          "client_id",
          "client_secret",
        ];
        for (const field of legacyFields) {
          const key = credentialKey(providerKey, field);
          const result = await deleteSecureKeyAsync(key);
          if (result === "deleted") cleanedUp = true;

          const metaDeleted = deleteCredentialMetadata(providerKey, field);
          if (metaDeleted) cleanedUp = true;
        }

        if (!cleanedUp) {
          writeOutput(cmd, {
            ok: false,
            error: `No OAuth connection or credentials found for "${providerKey}"`,
          });
          process.exitCode = 1;
          return;
        }

        writeOutput(cmd, { ok: true, service: providerKey });

        if (!shouldOutputJson(cmd)) {
          log.info(`Disconnected ${providerKey}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // connections connect <provider-key>
  // ---------------------------------------------------------------------------

  connections
    .command("connect <provider-key>")
    .description("Initiate an OAuth2 authorization flow for a provider")
    .option("--client-id <id>", "Override the OAuth client ID")
    .option("--client-secret <secret>", "Override the OAuth client secret")
    .option(
      "--scopes <scopes...>",
      "Additional scopes beyond the provider's defaults",
    )
    .option("--url-only", "Print the auth URL instead of opening the browser")
    .addHelpText(
      "after",
      `
Arguments:
  provider-key   Provider key (e.g. integration:gmail) or alias (e.g. gmail)

Initiates an OAuth2 authorization flow for the given provider. By default,
opens the authorization URL in your browser and waits for completion.

With --url-only, prints the auth URL instead — useful for headless/remote
sessions. The token exchange completes in the background when the user
authorizes.

Client credentials are resolved from the OAuth app store unless overridden
with --client-id and --client-secret.

Examples:
  $ assistant oauth connections connect integration:gmail
  $ assistant oauth connections connect gmail --url-only
  $ assistant oauth connections connect integration:slack --client-id abc --client-secret s3cret
  $ assistant oauth connections connect integration:gmail --scopes calendar.readonly --json`,
    )
    .action(
      async (
        providerKey: string,
        opts: {
          clientId?: string;
          clientSecret?: string;
          scopes?: string[];
          urlOnly?: boolean;
        },
        cmd: Command,
      ) => {
        try {
          // a. Resolve service alias
          const resolvedServiceKey = resolveService(providerKey);

          // b. Resolve client credentials
          let clientId = opts.clientId;
          let clientSecret = opts.clientSecret;

          if (!clientId || !clientSecret) {
            const dbApp = clientId
              ? getAppByProviderAndClientId(resolvedServiceKey, clientId)
              : getMostRecentAppByProvider(resolvedServiceKey);

            if (dbApp) {
              if (!clientId) clientId = dbApp.clientId;
              if (!clientSecret) {
                const storedSecret = getSecureKey(
                  `oauth_app/${dbApp.id}/client_secret`,
                );
                if (storedSecret) clientSecret = storedSecret;
              }
            }
          }

          // c. Validate client_id
          if (!clientId) {
            writeOutput(cmd, {
              ok: false,
              error:
                "No client_id found. Provide --client-id or register an app first with 'assistant oauth apps upsert'.",
            });
            process.exitCode = 1;
            return;
          }

          // d. Check if client_secret is required but missing
          if (clientSecret === undefined) {
            const providerRow = getProvider(resolvedServiceKey);
            const behavior = getProviderBehavior(resolvedServiceKey);

            const requiresSecret = behavior?.setup?.requiresClientSecret
              ? true
              : !!(
                  providerRow?.tokenEndpointAuthMethod ||
                  providerRow?.extraParams
                );

            if (requiresSecret) {
              writeOutput(cmd, {
                ok: false,
                error: `client_secret is required for ${resolvedServiceKey} but not found. Provide --client-secret or store it first with 'assistant oauth apps upsert --client-secret'.`,
              });
              process.exitCode = 1;
              return;
            }
          }

          // e. Call the orchestrator
          const result = await orchestrateOAuthConnect({
            service: providerKey,
            clientId,
            clientSecret,
            isInteractive: !opts.urlOnly,
            openUrl: !opts.urlOnly
              ? (url) => {
                  Bun.spawn(["open", url], {
                    stdout: "ignore",
                    stderr: "ignore",
                  });
                }
              : undefined,
            ...(opts.scopes ? { requestedScopes: opts.scopes } : {}),
          });

          // f. Handle results
          if (!result.success) {
            writeOutput(cmd, { ok: false, error: result.error });
            process.exitCode = 1;
            return;
          }

          if (result.deferred) {
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, {
                ok: true,
                deferred: true,
                authUrl: result.authUrl,
                service: result.service,
              });
            } else {
              process.stdout.write(
                `Open this URL to authorize:\n\n${result.authUrl}\n\nThe connection will complete automatically once you authorize.\n`,
              );
            }
            return;
          }

          // Interactive mode completed
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, {
              ok: true,
              grantedScopes: result.grantedScopes,
              accountInfo: result.accountInfo,
            });
          } else {
            const msg = `Connected to ${resolvedServiceKey}${result.accountInfo ? ` as ${result.accountInfo}` : ""}`;
            process.stdout.write(msg + "\n");
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );
}
