import { type Command } from "commander";

import { loadConfig } from "../../../config/loader.js";
import { getOAuthCallbackUrl } from "../../../inbound/public-ingress-urls.js";
import {
  deleteApp,
  deleteConnection,
  deleteProvider,
  disconnectOAuthProvider,
  getProvider,
  listApps,
  listConnections,
  listProviders,
  registerProvider,
  updateProvider,
} from "../../../oauth/oauth-store.js";
import { getProviderBehavior } from "../../../oauth/provider-behaviors.js";
import { SEEDED_PROVIDER_KEYS } from "../../../oauth/seed-providers.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

const LOOPBACK_CALLBACK_PATH = "/oauth/callback";

/** Resolve the redirect URI for a provider based on its callback transport. */
function resolveRedirectUri(
  providerKey: string,
  callbackTransport: string | null,
): string | null {
  const transport = callbackTransport ?? "loopback";
  if (transport === "loopback") {
    const behavior = getProviderBehavior(providerKey);
    const port = behavior?.loopbackPort;
    if (!port) {
      // No fixed port — loopback still works at runtime with an OS-assigned
      // port, but we can't predict the redirect URI ahead of time.  Return
      // a sentinel so callers know the transport is loopback-dynamic rather
      // than unsupported.
      return "http://localhost:<dynamic>/oauth/callback";
    }
    return `http://localhost:${port}${LOOPBACK_CALLBACK_PATH}`;
  }
  // Gateway transport — resolve from public ingress config.
  // Try the explicit publicBaseUrl first, then fall back to platform
  // callback registration (containerised/managed deployments).
  try {
    return getOAuthCallbackUrl(loadConfig());
  } catch {
    // publicBaseUrl not configured — not necessarily an error for
    // platform-managed deployments where the callback URL is resolved
    // dynamically at connection time via platform route registration.
    return null;
  }
}

/** Parse stored JSON string fields into their native types. */
function parseProviderRow(row: ReturnType<typeof getProvider>) {
  if (!row) return row;
  return {
    ...row,
    displayName: row.displayName ?? null,
    description: row.description ?? null,
    dashboardUrl: row.dashboardUrl ?? null,
    clientIdPlaceholder: row.clientIdPlaceholder ?? null,
    requiresClientSecret: !!(row.requiresClientSecret ?? 1),
    supportsManagedMode: !!row.managedServiceConfigKey,
    defaultScopes: row.defaultScopes ? JSON.parse(row.defaultScopes) : [],
    scopePolicy: row.scopePolicy ? JSON.parse(row.scopePolicy) : {},
    extraParams: row.extraParams ? JSON.parse(row.extraParams) : null,
    pingHeaders: row.pingHeaders ? JSON.parse(row.pingHeaders) : null,
    pingBody: row.pingBody ? JSON.parse(row.pingBody) : null,
    redirectUri: resolveRedirectUri(row.providerKey, row.callbackTransport),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export function registerProviderCommands(oauth: Command): void {
  const providers = oauth
    .command("providers")
    .description(
      "Fetch configured OAuth providers and register custom providers of your own",
    );

  providers.addHelpText(
    "after",
    `
Providers define the protocol-level configuration for an OAuth integration:
authorization URL, token URL, default scopes, and other endpoint details.

They are seeded on startup for built-in integrations (e.g. Google, Slack,
GitHub) but can also be registered dynamically via the "register" subcommand.

Each provider is identified by a provider key (e.g. "google").`,
  );

  // ---------------------------------------------------------------------------
  // providers list
  // ---------------------------------------------------------------------------

  providers
    .command("list")
    .description("List all registered OAuth providers")
    .option(
      "--provider-key <key>",
      'Filter by provider key substring (case-insensitive). Comma-separated values are OR\'d (e.g. "google,slack")',
    )
    .addHelpText(
      "after",
      `
Returns registered OAuth providers, including both built-in providers
seeded at startup and any dynamically registered via "providers register".

When --provider-key is specified, only providers whose key contains the
given substring (case-insensitive) are returned. Multiple substrings can
be OR'd together using commas (e.g. "google,slack" matches any provider
whose key contains "google" OR "slack"). Without the flag, all providers
are listed.

Each provider row includes its key, auth URL, token URL, default scopes,
and configuration timestamps.

Examples:
  $ assistant oauth providers list
  $ assistant oauth providers list --provider-key google
  $ assistant oauth providers list --provider-key "google,slack"
  $ assistant oauth providers list --provider-key notion --json`,
    )
    .action((opts: { providerKey?: string }, cmd: Command) => {
      try {
        let rows = listProviders().map(parseProviderRow);

        if (opts.providerKey) {
          const needles = opts.providerKey
            .split(",")
            .map((n) => n.trim().toLowerCase())
            .filter(Boolean);
          rows = rows.filter(
            (r) =>
              r &&
              needles.some((needle) =>
                r.providerKey.toLowerCase().includes(needle),
              ),
          );
        }

        if (!shouldOutputJson(cmd)) {
          log.info(`Found ${rows.length} provider(s)`);
        }

        writeOutput(cmd, rows);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // providers get <provider-key>
  // ---------------------------------------------------------------------------

  providers
    .command("get <provider-key>")
    .description("Show details of a specific OAuth provider")
    .addHelpText(
      "after",
      `
Arguments:
  provider-key   Provider key (e.g. "google").
                 Must match the key used during registration or seeding.

Returns the full provider configuration including auth URL, token URL,
default scopes, scope policy, and extra parameters. Exits with code 1
if the provider key is not found.

Examples:
  $ assistant oauth providers get google
  $ assistant oauth providers get twitter --json`,
    )
    .action((providerKey: string, _opts: unknown, cmd: Command) => {
      try {
        const row = getProvider(providerKey);

        if (!row) {
          writeOutput(cmd, {
            ok: false,
            error: `Provider not found: "${providerKey}". Run 'assistant oauth providers list' to see all registered providers. To register a custom provider, run 'assistant oauth providers register --help'.`,
          });
          process.exitCode = 1;
          return;
        }

        writeOutput(cmd, parseProviderRow(row));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // providers register
  // ---------------------------------------------------------------------------

  providers
    .command("register")
    .description("Register a new OAuth provider configuration")
    .requiredOption(
      "--provider-key <key>",
      "Unique provider key (e.g. \"custom-service\"). Must not collide with an existing key from 'assistant oauth providers list'.",
    )
    .requiredOption(
      "--auth-url <url>",
      "OAuth authorization endpoint URL (e.g. https://accounts.example.com/o/oauth2/auth)",
    )
    .requiredOption(
      "--token-url <url>",
      "OAuth token endpoint URL (e.g. https://oauth2.example.com/token)",
    )
    .option("--base-url <url>", "API base URL for the service")
    .option("--userinfo-url <url>", "OpenID Connect userinfo endpoint URL")
    .option(
      "--scopes <scopes>",
      'Comma-separated default scopes (e.g. "read,write,profile")',
    )
    .option(
      "--token-auth-method <method>",
      'How the client authenticates at the token endpoint: "client_secret_post" or "client_secret_basic"',
    )
    .option(
      "--callback-transport <transport>",
      'OAuth callback transport: "loopback" (local HTTP server, default) or "gateway" (public ingress)',
    )
    .option(
      "--ping-url <url>",
      'Health-check endpoint URL for token validation (e.g. "https://api.example.com/user"). Used by "assistant oauth ping" to verify a stored token.',
    )
    .option(
      "--ping-method <method>",
      "HTTP method for the ping endpoint: GET (default) or POST",
    )
    .option(
      "--ping-headers <json>",
      'JSON object of extra headers for the ping request (e.g. \'{"Notion-Version":"2022-06-28"}\')',
    )
    .option(
      "--ping-body <json>",
      'JSON body to send with the ping request (e.g. \'{"query":"{ viewer { id } }"}\')',
    )
    .option(
      "--display-name <name>",
      "Human-readable display name for the provider",
    )
    .option("--description <text>", "Short description of the provider")
    .option(
      "--dashboard-url <url>",
      "URL to the provider's developer console / dashboard",
    )
    .option(
      "--client-id-placeholder <text>",
      "Placeholder text shown in the client ID input field",
    )
    .option(
      "--no-client-secret",
      "Mark this provider as not requiring a client secret (default: required)",
    )
    .addHelpText(
      "after",
      `
Registers a new OAuth provider configuration in the local store for custom
integrations not covered by the built-in provider seeds. The provider key
must be unique — if it collides with an existing key, the command fails.
Run 'assistant oauth providers list' to see existing keys.

On success, returns the full provider row including generated timestamps.
After registering, create an OAuth app with 'assistant oauth apps create'
and then connect with 'assistant oauth connect <provider-key>'.

Examples:
  $ assistant oauth providers register \\
      --provider-key custom-api \\
      --auth-url https://custom-api.example.com/oauth/authorize \\
      --token-url https://custom-api.example.com/oauth/token
  $ assistant oauth providers register \\
      --provider-key my-service \\
      --auth-url https://my-service.com/auth \\
      --token-url https://my-service.com/token \\
      --scopes read,write --json
  $ assistant oauth providers register \\
      --provider-key my-graphql-api \\
      --auth-url https://example.com/auth \\
      --token-url https://example.com/token \\
      --ping-url https://example.com/graphql \\
      --ping-method POST \\
      --ping-body '{"query":"{ viewer { id } }"}'`,
    )
    .action(
      (
        opts: {
          providerKey: string;
          authUrl: string;
          tokenUrl: string;
          baseUrl?: string;
          userinfoUrl?: string;
          scopes?: string;
          tokenAuthMethod?: string;
          callbackTransport?: string;
          pingUrl?: string;
          pingMethod?: string;
          pingHeaders?: string;
          pingBody?: string;
          displayName?: string;
          description?: string;
          dashboardUrl?: string;
          clientIdPlaceholder?: string;
          clientSecret: boolean;
        },
        cmd: Command,
      ) => {
        try {
          const row = registerProvider({
            providerKey: opts.providerKey,
            authUrl: opts.authUrl,
            tokenUrl: opts.tokenUrl,
            baseUrl: opts.baseUrl,
            userinfoUrl: opts.userinfoUrl,
            defaultScopes: opts.scopes ? opts.scopes.split(",") : [],
            scopePolicy: {},
            tokenEndpointAuthMethod: opts.tokenAuthMethod,
            callbackTransport: opts.callbackTransport,
            pingUrl: opts.pingUrl,
            pingMethod: opts.pingMethod,
            pingHeaders: opts.pingHeaders
              ? JSON.parse(opts.pingHeaders)
              : undefined,
            pingBody: opts.pingBody ? JSON.parse(opts.pingBody) : undefined,
            displayName: opts.displayName,
            description: opts.description,
            dashboardUrl: opts.dashboardUrl,
            clientIdPlaceholder: opts.clientIdPlaceholder,
            requiresClientSecret: opts.clientSecret ? 1 : 0,
          });

          writeOutput(cmd, parseProviderRow(row));
        } catch (err) {
          let message = err instanceof Error ? err.message : String(err);
          if (message.includes("already exists")) {
            message += ` Run 'assistant oauth providers list' to see existing providers, or choose a different --provider-key.`;
          }
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );

  // ---------------------------------------------------------------------------
  // providers update <provider-key>
  // ---------------------------------------------------------------------------

  providers
    .command("update <provider-key>")
    .description("Update an existing custom OAuth provider configuration")
    .option(
      "--auth-url <url>",
      "OAuth authorization endpoint URL (e.g. https://accounts.example.com/o/oauth2/auth)",
    )
    .option(
      "--token-url <url>",
      "OAuth token endpoint URL (e.g. https://oauth2.example.com/token)",
    )
    .option("--base-url <url>", "API base URL for the service")
    .option("--userinfo-url <url>", "OpenID Connect userinfo endpoint URL")
    .option(
      "--scopes <scopes>",
      'Comma-separated default scopes (e.g. "read,write,profile")',
    )
    .option(
      "--token-auth-method <method>",
      'How the client authenticates at the token endpoint: "client_secret_post" or "client_secret_basic"',
    )
    .option(
      "--callback-transport <transport>",
      'OAuth callback transport: "loopback" (local HTTP server, default) or "gateway" (public ingress)',
    )
    .option(
      "--ping-url <url>",
      'Health-check endpoint URL for token validation (e.g. "https://api.example.com/user"). Used by "assistant oauth ping" to verify a stored token.',
    )
    .option(
      "--ping-method <method>",
      "HTTP method for the ping endpoint: GET (default) or POST",
    )
    .option(
      "--ping-headers <json>",
      'JSON object of extra headers for the ping request (e.g. \'{"Notion-Version":"2022-06-28"}\')',
    )
    .option(
      "--ping-body <json>",
      'JSON body to send with the ping request (e.g. \'{"query":"{ viewer { id } }"}\')',
    )
    .option(
      "--display-name <name>",
      "Human-readable display name for the provider",
    )
    .option("--description <text>", "Short description of the provider")
    .option(
      "--dashboard-url <url>",
      "URL to the provider's developer console / dashboard",
    )
    .option(
      "--client-id-placeholder <text>",
      "Placeholder text shown in the client ID input field",
    )
    .option(
      "--no-client-secret",
      "Mark this provider as not requiring a client secret (default: required)",
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider-key   Provider key to update (e.g. "custom-api").
                 Run 'assistant oauth providers list' to see all registered providers.

Only the fields you specify are updated — all other fields remain unchanged.
Built-in providers (e.g. "google", "slack") cannot be updated; they are
managed by the system and reset on startup. To create a custom provider with
different settings, use 'assistant oauth providers register'.

Examples:
  $ assistant oauth providers update custom-api --display-name "My Custom API"
  $ assistant oauth providers update custom-api --scopes read,write --auth-url https://new.example.com/auth
  $ assistant oauth providers update custom-api --ping-url https://api.example.com/me --json`,
    )
    .action(
      (
        providerKey: string,
        opts: {
          authUrl?: string;
          tokenUrl?: string;
          baseUrl?: string;
          userinfoUrl?: string;
          scopes?: string;
          tokenAuthMethod?: string;
          callbackTransport?: string;
          pingUrl?: string;
          pingMethod?: string;
          pingHeaders?: string;
          pingBody?: string;
          displayName?: string;
          description?: string;
          dashboardUrl?: string;
          clientIdPlaceholder?: string;
          clientSecret: boolean;
        },
        cmd: Command,
      ) => {
        try {
          // Verify provider exists
          const existing = getProvider(providerKey);
          if (!existing) {
            writeOutput(cmd, {
              ok: false,
              error: `Provider "${providerKey}" not found. Run 'assistant oauth providers list' to see all registered providers.`,
            });
            process.exitCode = 1;
            return;
          }

          // Block updates to built-in providers
          if (SEEDED_PROVIDER_KEYS.has(providerKey)) {
            writeOutput(cmd, {
              ok: false,
              error: `Cannot update built-in provider "${providerKey}". Built-in providers are managed by the system and reset on startup. To create a custom provider with different settings, use 'assistant oauth providers register --provider-key <your-custom-key> ...'`,
            });
            process.exitCode = 1;
            return;
          }

          // Build params object from provided options, omitting undefined values
          const params: Record<string, unknown> = {};

          if (opts.authUrl !== undefined) params.authUrl = opts.authUrl;
          if (opts.tokenUrl !== undefined) params.tokenUrl = opts.tokenUrl;
          if (opts.baseUrl !== undefined) params.baseUrl = opts.baseUrl;
          if (opts.userinfoUrl !== undefined)
            params.userinfoUrl = opts.userinfoUrl;
          if (opts.scopes !== undefined)
            params.defaultScopes = opts.scopes.split(",");
          if (opts.tokenAuthMethod !== undefined)
            params.tokenEndpointAuthMethod = opts.tokenAuthMethod;
          if (opts.callbackTransport !== undefined)
            params.callbackTransport = opts.callbackTransport;
          if (opts.pingUrl !== undefined) params.pingUrl = opts.pingUrl;
          if (opts.pingMethod !== undefined)
            params.pingMethod = opts.pingMethod;
          if (opts.pingHeaders !== undefined)
            params.pingHeaders = JSON.parse(opts.pingHeaders);
          if (opts.pingBody !== undefined)
            params.pingBody = JSON.parse(opts.pingBody);
          if (opts.displayName !== undefined)
            params.displayName = opts.displayName;
          if (opts.description !== undefined)
            params.description = opts.description;
          if (opts.dashboardUrl !== undefined)
            params.dashboardUrl = opts.dashboardUrl;
          if (opts.clientIdPlaceholder !== undefined)
            params.clientIdPlaceholder = opts.clientIdPlaceholder;

          // Handle the negated --no-client-* flag: Commander defaults
          // opts.clientSecret to true; the negated form sets it to false.
          // Use getOptionValueSource to detect explicit user intent.
          if (cmd.getOptionValueSource("clientSecret") === "cli") {
            params.requiresClientSecret = opts.clientSecret ? 1 : 0;
          }

          // Check if any fields were actually provided
          if (Object.keys(params).length === 0) {
            writeOutput(cmd, {
              ok: false,
              error:
                "Nothing to update. Provide at least one option to change (e.g. --auth-url, --scopes, --display-name). Run 'assistant oauth providers update --help' for all options.",
            });
            process.exitCode = 1;
            return;
          }

          const row = updateProvider(providerKey, params);

          writeOutput(cmd, parseProviderRow(row));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );

  // ---------------------------------------------------------------------------
  // providers delete <provider-key>
  // ---------------------------------------------------------------------------

  providers
    .command("delete <provider-key>")
    .description(
      "Delete a custom OAuth provider and optionally its associated apps and connections",
    )
    .option(
      "--force",
      "Cascade-delete all associated apps and connections before removing the provider",
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider-key   Provider key to delete (e.g. "custom-api").
                 Run 'assistant oauth providers list' to see registered providers.

When --force is specified, all OAuth connections and apps that depend on
this provider are deleted before the provider itself is removed. Without
--force, the command refuses to delete a provider that has dependents and
exits with an error listing the counts.

Built-in providers (e.g. "google", "slack") can be deleted, but a warning
is emitted because they will be re-created automatically on the next
assistant startup.

Examples:
  $ assistant oauth providers delete custom-api
  $ assistant oauth providers delete custom-api --force
  $ assistant oauth providers delete custom-api --force --json`,
    )
    .action(
      async (providerKey: string, opts: { force?: boolean }, cmd: Command) => {
        try {
          const provider = getProvider(providerKey);
          if (!provider) {
            writeOutput(cmd, {
              ok: false,
              error: `Provider not found: "${providerKey}". Run 'assistant oauth providers list' to see all registered providers.`,
            });
            process.exitCode = 1;
            return;
          }

          if (SEEDED_PROVIDER_KEYS.has(providerKey) && !opts.force) {
            log.info(
              `Note: "${providerKey}" is a built-in provider and will be re-created on next startup.`,
            );
          }

          const dependentApps = listApps().filter(
            (a) => a.providerKey === providerKey,
          );
          const dependentConnections = listConnections(providerKey);
          const appCount = dependentApps.length;
          const connCount = dependentConnections.length;

          if ((appCount > 0 || connCount > 0) && !opts.force) {
            writeOutput(cmd, {
              ok: false,
              error: `Cannot delete provider "${providerKey}": ${appCount} app(s) and ${connCount} connection(s) depend on it. Use --force to cascade-delete all dependent apps and connections, or remove them manually first with 'assistant oauth apps delete' and 'assistant oauth disconnect'.`,
            });
            process.exitCode = 1;
            return;
          }

          // Warn about built-in providers when --force is used
          if (SEEDED_PROVIDER_KEYS.has(providerKey) && opts.force) {
            log.info(
              `Note: "${providerKey}" is a built-in provider and will be re-created on next startup.`,
            );
          }

          // Cascade-delete connections first, then apps, then the provider.
          // Use disconnectOAuthProvider to clean up OAuth tokens from secure
          // storage in addition to deleting the connection DB row.
          for (const conn of dependentConnections) {
            const result = await disconnectOAuthProvider(
              providerKey,
              undefined,
              conn.id as string,
            );
            if (result === "error") {
              log.info(
                `Warning: failed to clean up tokens for connection ${conn.id} — deleting connection row to continue cascade.`,
              );
              deleteConnection(conn.id);
            }
          }
          for (const app of dependentApps) {
            await deleteApp(app.id);
          }
          deleteProvider(providerKey);

          if (!shouldOutputJson(cmd)) {
            log.info(`Deleted provider: ${providerKey}`);
          }

          writeOutput(cmd, {
            ok: true,
            deleted: { provider: 1, apps: appCount, connections: connCount },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );
}
