import { type Command, InvalidArgumentError } from "commander";

import {
  getProvider,
  listProviders,
  registerProvider,
} from "../../../oauth/oauth-store.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

/** Parse stored JSON string fields into their native types. */
function parseProviderRow(row: ReturnType<typeof getProvider>) {
  if (!row) return row;
  return {
    ...row,
    defaultScopes: row.defaultScopes ? JSON.parse(row.defaultScopes) : [],
    scopePolicy: row.scopePolicy ? JSON.parse(row.scopePolicy) : {},
    extraParams: row.extraParams ? JSON.parse(row.extraParams) : null,
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

They are seeded on startup for built-in integrations (e.g. Gmail, Twitter,
Slack) but can also be registered dynamically via the "register" subcommand.

Each provider is identified by a provider key (e.g. "integration:gmail").`,
  );

  // ---------------------------------------------------------------------------
  // providers list
  // ---------------------------------------------------------------------------

  providers
    .command("list")
    .description("List all registered OAuth providers")
    .addHelpText(
      "after",
      `
Returns all registered OAuth providers, including both built-in providers
seeded at startup and any dynamically registered via "providers register".

Each provider row includes its key, auth URL, token URL, default scopes,
and configuration timestamps.

Examples:
  $ assistant oauth providers list
  $ assistant oauth providers list --json`,
    )
    .action((_opts: unknown, cmd: Command) => {
      try {
        const rows = listProviders().map(parseProviderRow);

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
  provider-key   The full provider key (e.g. "integration:gmail").
                 Must match the key used during registration or seeding.

Returns the full provider configuration including auth URL, token URL,
default scopes, scope policy, and extra parameters. Exits with code 1
if the provider key is not found.

Examples:
  $ assistant oauth providers get integration:gmail
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
    .option("--loopback-port <port>", "Loopback port", (value: string) => {
      const port = parseInt(value, 10);
      if (isNaN(port) || port <= 0 || port > 65535) {
        throw new InvalidArgumentError(
          "Port must be a number between 1 and 65535",
        );
      }
      return port;
    })
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
  --loopback-port       Port number for the local loopback callback server (1-65535).

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
      --scopes read,write --json`,
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
          loopbackPort?: number;
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
            loopbackPort: opts.loopbackPort,
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
