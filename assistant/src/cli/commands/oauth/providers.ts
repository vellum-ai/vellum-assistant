import { type Command } from "commander";

import { loadConfig } from "../../../config/loader.js";
import { getOAuthCallbackUrl } from "../../../inbound/public-ingress-urls.js";
import {
  getProvider,
  listProviders,
  registerProvider,
} from "../../../oauth/oauth-store.js";
import { getProviderBehavior } from "../../../oauth/provider-behaviors.js";
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
    defaultScopes: row.defaultScopes ? JSON.parse(row.defaultScopes) : [],
    scopePolicy: row.scopePolicy ? JSON.parse(row.scopePolicy) : {},
    extraParams: row.extraParams ? JSON.parse(row.extraParams) : null,
    redirectUri: resolveRedirectUri(row.providerKey, row.callbackTransport),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export function registerProviderCommands(oauth: Command): void {
  const providers = oauth
    .command("providers")
    .description(
      "Manage OAuth provider configurations (auth URLs, scopes, endpoints)",
    );

  providers.addHelpText(
    "after",
    `
Providers define the protocol-level configuration for an OAuth integration:
authorization URL, token URL, default scopes, and other endpoint details.

They are seeded on startup for built-in integrations (e.g. Google, Slack,
GitHub) but can also be registered dynamically via the "register" subcommand.

Each provider is identified by a provider key (e.g. "integration:google").`,
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
  provider-key   The full provider key (e.g. "integration:google").
                 Must match the key used during registration or seeding.

Returns the full provider configuration including auth URL, token URL,
default scopes, scope policy, and extra parameters. Exits with code 1
if the provider key is not found.

Examples:
  $ assistant oauth providers get integration:google
  $ assistant oauth providers get integration:twitter --json`,
    )
    .action((providerKey: string, _opts: unknown, cmd: Command) => {
      try {
        const row = getProvider(providerKey);

        if (!row) {
          writeOutput(cmd, {
            ok: false,
            error: `Provider not found: ${providerKey}`,
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
    .requiredOption("--provider-key <key>", "Provider key")
    .requiredOption("--auth-url <url>", "Authorization endpoint URL")
    .requiredOption("--token-url <url>", "Token endpoint URL")
    .option("--base-url <url>", "API base URL")
    .option("--userinfo-url <url>", "Userinfo endpoint URL")
    .option("--scopes <scopes>", "Comma-separated default scopes")
    .option("--token-auth-method <method>", "Token endpoint auth method")
    .option("--callback-transport <transport>", "Callback transport")
    .option(
      "--ping-url <url>",
      "Health-check endpoint URL for token validation",
    )
    .addHelpText(
      "after",
      `
Arguments (via options):
  --provider-key        Unique identifier for this provider (e.g. "integration:custom-service").
                        Must not collide with an existing provider key.
  --auth-url            The OAuth authorization endpoint URL.
  --token-url           The OAuth token endpoint URL.
  --base-url            Optional API base URL for the service.
  --userinfo-url        Optional OpenID Connect userinfo endpoint.
  --scopes              Comma-separated list of default scopes (e.g. "read,write,profile").
  --token-auth-method   How the client authenticates at the token endpoint
                        (e.g. "client_secret_post", "client_secret_basic").
  --callback-transport  Transport method for the OAuth callback.
  --ping-url            Optional URL for a lightweight health-check endpoint.
                        Used by "connections ping" to validate that a stored token
                        is still functional (e.g. "https://api.example.com/user").

Registers a new OAuth provider configuration in the local store. This is
used for custom integrations not covered by the built-in provider seeds.
On success, returns the full provider row including generated timestamps.

Examples:
  $ assistant oauth providers register \\
      --provider-key integration:custom-api \\
      --auth-url https://custom-api.example.com/oauth/authorize \\
      --token-url https://custom-api.example.com/oauth/token
  $ assistant oauth providers register \\
      --provider-key integration:my-service \\
      --auth-url https://my-service.com/auth \\
      --token-url https://my-service.com/token \\
      --scopes read,write --json
  $ assistant oauth providers register \\
      --provider-key integration:custom-api \\
      --auth-url https://example.com/auth \\
      --token-url https://example.com/token \\
      --ping-url https://example.com/user`,
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
          });

          writeOutput(cmd, parseProviderRow(row));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );
}
