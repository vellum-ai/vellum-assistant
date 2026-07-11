/** Declarative help for the `assistant oauth` command. */

import type { CliCommandHelp } from "../../lib/cli-command-help.js";

export const oauthHelp: CliCommandHelp = {
  name: "oauth",
  description:
    "Manage the full OAuth lifecycle — registering providers, creating apps, connecting accounts, and making authenticated requests",
  options: [
    { flags: "--json", description: "Machine-readable compact JSON output" },
  ],
  helpText: `
OAuth providers may support up to two modes – "managed" and "your-own".
  managed:
    Requires a Vellum Platform account. For providers that support it, managed mode offloads the burden of needing to create and register an oauth app.
    Vellum Platform manages oauth token management and refresh and proxies requests to the provier.
  you-own:
    Provides ultimate control and removes dependency on Vellum Platform, but requires that you set up your own oauth app and register it
    via \`assistant oauth apps upsert\`.
All commands are intended to work regardless of the provider's mode. Check and set the mode for a given provider with \`assistant oauth mode\`.

You can define entirely new oauth providers to integrate with even if they do not show up using \`assistant oauth providers list\` using
\`assistant oauth providers register\`. Custom-registered providers only support "your-own" mode.


Examples:
  assistant oauth providers list
  assistant oauth providers get google
  assistant oauth mode google --set=managed
  assistant oauth connect google
  assistant oauth status google
  assistant oauth ping google
  assistant oauth request --provider google /gmail/v1/users/me/messages
  assistant oauth disconnect google`,
  subcommands: [
    {
      name: "providers",
      description:
        "Fetch configured OAuth providers and register custom providers of your own",
      helpText: `
Providers define the protocol-level configuration for an OAuth integration:
authorization URL, token URL, default scopes, and other endpoint details.

They are seeded on startup for built-in integrations (e.g. Google, Slack,
GitHub) but can also be registered dynamically via the "register" subcommand.

Each provider is identified by a provider key (e.g. "google").`,
      subcommands: [
        {
          name: "list",
          description: "List all registered OAuth providers",
          options: [
            {
              flags: "--provider-key <key>",
              description:
                'Filter by provider key substring (case-insensitive). Comma-separated values are OR\'d (e.g. "google,slack")',
            },
            {
              flags: "--supports-managed",
              description: "Only show providers that support managed mode",
            },
          ],
          helpText: `
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
  $ assistant oauth providers list --provider-key notion --json
  $ assistant oauth providers list --supports-managed
  $ assistant oauth providers list --supports-managed --json`,
        },
        {
          name: "get",
          args: "<provider-key>",
          description: "Show details of a specific OAuth provider",
          helpText: `
Arguments:
  provider-key   Provider key (e.g. "google").
                 Must match the key used during registration or seeding.

Returns the full provider configuration including auth URL, token URL,
default scopes, available scopes, and extra parameters. Exits with code 1
if the provider key is not found.

Examples:
  $ assistant oauth providers get google
  $ assistant oauth providers get twitter --json`,
        },
        {
          name: "register",
          description: "Register a new OAuth provider configuration",
          options: [
            {
              flags: "--provider-key <key>",
              description:
                "Unique provider key (e.g. \"custom-service\"). Must not collide with an existing key from 'assistant oauth providers list'.",
              required: true,
            },
            {
              flags: "--auth-url <url>",
              description:
                "OAuth authorization endpoint URL (e.g. https://accounts.example.com/o/oauth2/auth)",
              required: true,
            },
            {
              flags: "--token-url <url>",
              description:
                "OAuth token endpoint URL (e.g. https://oauth2.example.com/token)",
              required: true,
            },
            {
              flags: "--refresh-url <url>",
              description:
                "OAuth token refresh endpoint URL. Defaults to --token-url when omitted.",
            },
            {
              flags: "--base-url <url>",
              description: "API base URL for the service",
            },
            {
              flags: "--userinfo-url <url>",
              description: "OpenID Connect userinfo endpoint URL",
            },
            {
              flags: "--scopes <scopes>",
              description:
                'Comma-separated default scopes (e.g. "read,write,profile")',
            },
            {
              flags: "--scope-separator <sep>",
              description:
                'Separator used to join scopes in the authorize URL (default: " ").',
            },
            {
              flags: "--token-auth-method <method>",
              description:
                'How the client authenticates at the token endpoint: "client_secret_post" or "client_secret_basic"',
            },
            {
              flags: "--token-exchange-body-format <format>",
              description:
                'Body encoding for the token exchange request: "form" (default) or "json"',
              defaultValue: "form",
            },
            {
              flags: "--ping-url <url>",
              description: "Health-check endpoint URL for token validation",
            },
            {
              flags: "--ping-method <method>",
              description:
                "HTTP method for the ping endpoint: GET (default) or POST",
            },
            {
              flags: "--ping-headers <json>",
              description: "JSON object of extra headers for the ping request",
            },
            {
              flags: "--ping-body <json>",
              description: "JSON body to send with the ping request",
            },
            {
              flags: "--revoke-url <url>",
              description: "OAuth token revocation endpoint URL",
            },
            {
              flags: "--revoke-body-template <json>",
              description: "JSON object body template for the revoke request",
            },
            {
              flags: "--display-name <name>",
              description: "Human-readable display name for the provider",
            },
            {
              flags: "--description <text>",
              description: "Short description of the provider",
            },
            {
              flags: "--dashboard-url <url>",
              description:
                "URL to the provider's developer console / dashboard",
            },
            {
              flags: "--logo-url <url>",
              description:
                "URL to the provider's logo image. Mutually exclusive with --logo-simpleicons-slug.",
            },
            {
              flags: "--logo-simpleicons-slug <slug>",
              description:
                'Simple Icons slug (e.g. "notion"). Mutually exclusive with --logo-url.',
            },
            {
              flags: "--client-id-placeholder <text>",
              description:
                "Placeholder text shown in the client ID input field",
            },
            {
              flags: "--no-client-secret",
              description:
                "Mark this provider as not requiring a client secret",
            },
            {
              flags: "--loopback-port <port>",
              description: "Fixed port for the local OAuth callback server",
            },
            {
              flags: "--injection-templates <json>",
              description: "JSON array of token injection templates",
            },
            {
              flags: "--app-type <type>",
              description:
                'What the provider calls its OAuth apps (e.g. "OAuth App")',
            },
            {
              flags: "--identity-url <url>",
              description: "Identity verification endpoint URL",
            },
            {
              flags: "--identity-method <method>",
              description:
                "HTTP method for the identity endpoint: GET (default) or POST",
            },
            {
              flags: "--identity-headers <json>",
              description:
                "JSON object of extra headers for the identity request",
            },
            {
              flags: "--identity-body <body>",
              description: "JSON body to send with the identity request",
            },
            {
              flags: "--identity-response-paths <paths>",
              description:
                "Comma-separated dot-notation paths to extract identity from the response",
            },
            {
              flags: "--identity-format <template>",
              description: "Format template for the extracted identity",
            },
            {
              flags: "--identity-ok-field <field>",
              description:
                "Dot-notation path to a boolean field that must be truthy for the response to be valid",
            },
            {
              flags: "--setup-notes <json>",
              description:
                "JSON array of setup instruction notes shown during guided setup",
            },
            {
              flags: "--available-scopes <value>",
              description:
                "Available scopes: either a JSON array of {scope, description?} objects or a URL",
            },
          ],
          helpText: `
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
      --scopes read,write --json`,
        },
        {
          name: "update",
          args: "<provider-key>",
          description: "Update an existing custom OAuth provider configuration",
          options: [
            {
              flags: "--auth-url <url>",
              description: "OAuth authorization endpoint URL",
            },
            {
              flags: "--token-url <url>",
              description: "OAuth token endpoint URL",
            },
            {
              flags: "--refresh-url <url>",
              description: "OAuth token refresh endpoint URL",
            },
            {
              flags: "--base-url <url>",
              description: "API base URL for the service",
            },
            {
              flags: "--userinfo-url <url>",
              description: "OpenID Connect userinfo endpoint URL",
            },
            {
              flags: "--scopes <scopes>",
              description:
                'Comma-separated default scopes (e.g. "read,write,profile")',
            },
            {
              flags: "--scope-separator <sep>",
              description: "Separator used to join scopes in the authorize URL",
            },
            {
              flags: "--token-auth-method <method>",
              description: "How the client authenticates at the token endpoint",
            },
            {
              flags: "--token-exchange-body-format <format>",
              description:
                'Body encoding for the token exchange request: "form" or "json"',
            },
            {
              flags: "--ping-url <url>",
              description: "Health-check endpoint URL",
            },
            {
              flags: "--ping-method <method>",
              description:
                "HTTP method for the ping endpoint: GET (default) or POST",
            },
            {
              flags: "--ping-headers <json>",
              description: "JSON object of extra headers for the ping request",
            },
            {
              flags: "--ping-body <json>",
              description: "JSON body for the ping request",
            },
            {
              flags: "--revoke-url <url>",
              description:
                "OAuth token revocation endpoint URL. Pass empty string to clear.",
            },
            {
              flags: "--revoke-body-template <json>",
              description:
                "JSON object body template for the revoke request. Pass empty string to clear.",
            },
            {
              flags: "--display-name <name>",
              description: "Human-readable display name",
            },
            {
              flags: "--description <text>",
              description: "Short description",
            },
            {
              flags: "--dashboard-url <url>",
              description: "Developer console / dashboard URL",
            },
            {
              flags: "--logo-url <url>",
              description:
                "URL to the provider's logo image. Mutually exclusive with --logo-simpleicons-slug.",
            },
            {
              flags: "--logo-simpleicons-slug <slug>",
              description:
                "Simple Icons slug. Mutually exclusive with --logo-url.",
            },
            {
              flags: "--client-id-placeholder <text>",
              description: "Placeholder for client ID input",
            },
            {
              flags: "--no-client-secret",
              description: "Mark as not requiring a client secret",
            },
            {
              flags: "--loopback-port <port>",
              description: "Fixed port for the local OAuth callback server",
            },
            {
              flags: "--injection-templates <json>",
              description: "JSON array of token injection templates",
            },
            {
              flags: "--app-type <type>",
              description: "What the provider calls its OAuth apps",
            },
            {
              flags: "--identity-url <url>",
              description: "Identity verification endpoint URL",
            },
            {
              flags: "--identity-method <method>",
              description: "HTTP method for identity endpoint",
            },
            {
              flags: "--identity-headers <json>",
              description: "JSON object of extra headers for identity request",
            },
            {
              flags: "--identity-body <body>",
              description: "JSON body for identity request",
            },
            {
              flags: "--identity-response-paths <paths>",
              description: "Comma-separated dot-notation paths",
            },
            {
              flags: "--identity-format <template>",
              description: "Format template for extracted identity",
            },
            {
              flags: "--identity-ok-field <field>",
              description: "Dot-notation path to a boolean ok field",
            },
            {
              flags: "--setup-notes <json>",
              description: "JSON array of setup instruction notes",
            },
            {
              flags: "--available-scopes <value>",
              description: "Available scopes: JSON array or URL",
            },
          ],
          helpText: `
Arguments:
  provider-key   Provider key to update (e.g. "custom-api").
                 Run 'assistant oauth providers list' to see all registered providers.

Only the fields you specify are updated — all other fields remain unchanged.
Built-in providers (e.g. "google", "slack") cannot be updated; they are
managed by the system and reset on startup.

Examples:
  $ assistant oauth providers update custom-api --display-name "My Custom API"
  $ assistant oauth providers update custom-api --scopes read,write --auth-url https://new.example.com/auth
  $ assistant oauth providers update custom-api --ping-url https://api.example.com/me --json
  $ assistant oauth providers update custom-api --logo-url ""`,
        },
        {
          name: "delete",
          args: "<provider-key>",
          description:
            "Delete a custom OAuth provider and optionally its associated apps and connections",
          options: [
            {
              flags: "--force",
              description:
                "Cascade-delete all associated apps and connections before removing the provider",
            },
          ],
          helpText: `
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
        },
      ],
    },
    {
      name: "mode",
      args: "<provider>",
      description: "Get or set the OAuth mode for a provider",
      options: [
        {
          flags: "--set <mode>",
          description:
            'Set the mode to "managed" (platform-handled credentials) or "your-own" (bring-your-own client ID and secret). Omit to show the current mode.',
        },
      ],
      helpText: `
Arguments:
  provider   Provider name (e.g. google, slack).
             Run "assistant oauth providers list" to see available providers.

Modes:
  managed    OAuth credentials are managed by the Vellum platform. The
             assistant connects via a platform-hosted authorization flow.
             No local client ID or secret is needed.
  your-own   You supply your own OAuth app credentials (client ID and
             secret). The assistant runs the OAuth flow locally.

Examples:
  $ assistant oauth mode google
  $ assistant oauth mode google --set your-own
  $ assistant oauth mode google --set managed`,
    },
    {
      name: "apps",
      description: "Manage custom OAuth app registrations",
      helpText: `
Apps represent custom OAuth client registrations — a client_id and optional
client_secret linked to a provider. Each provider can have multiple apps
(e.g. different client IDs for different environments). Only needed if using
a provider with a mode of "your-own" set.

Examples:
  $ assistant oauth apps list
  $ assistant oauth apps list --provider-key google
  $ assistant oauth apps get --id <uuid>
  $ assistant oauth apps get --provider google
  $ assistant oauth apps upsert --provider google --client-id abc123
  $ assistant oauth apps delete <id>`,
      subcommands: [
        {
          name: "list",
          description: "List all OAuth app registrations",
          options: [
            {
              flags: "--provider-key <key>",
              description:
                "Filter by provider key (exact match). Run 'assistant oauth providers list' to see available keys.",
            },
          ],
          helpText: `
Returns registered OAuth apps with their provider key, client ID, and
timestamps. Output is an array of app objects.

When --provider-key is specified, only apps whose provider exactly matches
the given value are returned. Without the flag, all apps are listed.

Examples:
  $ assistant oauth apps list
  $ assistant oauth apps list --provider-key google
  $ assistant oauth apps list --provider-key slack --json`,
        },
        {
          name: "get",
          description:
            "Look up an OAuth app by ID, provider + client-id, or provider",
          options: [
            {
              flags: "--id <id>",
              description: "App ID (UUID) from 'assistant oauth apps list'",
            },
            {
              flags: "--provider <key>",
              description:
                "Provider key (e.g. google) from 'assistant oauth providers list'",
            },
            {
              flags: "--client-id <id>",
              description:
                "OAuth client ID (requires --provider). Find registered client IDs via 'assistant oauth apps list'.",
            },
          ],
          helpText: `
Three lookup modes are supported:

  1. By app ID:
     $ assistant oauth apps get --id <uuid>

  2. By provider + client ID (exact match):
     $ assistant oauth apps get --provider google --client-id abc123

  3. By provider only (returns the most recently created app):
     $ assistant oauth apps get --provider google

At least --id or --provider must be specified.`,
        },
        {
          name: "upsert",
          description: "Create or return an existing OAuth app registration",
          options: [
            {
              flags: "--provider <key>",
              description:
                "Provider key (e.g. google) from 'assistant oauth providers list'",
              required: true,
            },
            {
              flags: "--client-id <id>",
              description:
                "OAuth client ID from the provider's developer console",
              required: true,
            },
            {
              flags: "--client-secret <secret>",
              description: "OAuth client secret (stored in credential store)",
            },
            {
              flags: "--client-secret-credential-path <path>",
              description:
                "Credential reference in service:field format (e.g. google:client_secret). Mutually exclusive with --client-secret.",
            },
          ],
          helpText: `
Creates a new app registration or returns the existing one if an app with the
same provider and client ID already exists. The client secret, if provided, is
stored in the secure credential store — not in the database.

When an existing app is matched and a --client-secret is provided, the stored
secret is updated. The app row itself is returned as-is.

You can supply the client secret directly via --client-secret, or reference an
existing credential in the store via --client-secret-credential-path. These two
options are mutually exclusive — providing both is an error.

Examples:
  $ assistant oauth apps upsert --provider google --client-id abc123
  $ assistant oauth apps upsert --provider slack --client-id def456 --client-secret s3cret
  $ assistant oauth apps upsert --provider slack --client-id def456 --client-secret-credential-path "slack:client_secret"
  $ assistant oauth apps upsert --provider google --client-id abc123 --json`,
        },
        {
          name: "delete",
          args: "<id>",
          description: "Delete an OAuth app registration by ID",
          helpText: `
Arguments:
  id   The app UUID to delete (as returned by "apps list" or "apps get")

Permanently removes the app registration and its stored client secret from
the credential store. Any OAuth connections that reference this app will no longer be
able to refresh tokens.

Exits with code 1 if the app ID is not found.

Examples:
  $ assistant oauth apps delete 550e8400-e29b-41d4-a716-446655440000
  $ assistant oauth apps delete 550e8400-e29b-41d4-a716-446655440000 --json`,
        },
      ],
    },
    {
      name: "connect",
      args: "<provider>",
      description:
        "Initiate an OAuth authorization flow for a specified provider",
      options: [
        {
          flags: "--scopes <scopes...>",
          description: "Scopes to request for the authorization",
        },
        {
          flags: "--no-browser",
          description:
            "Print the auth URL instead of opening it in the browser",
        },
        {
          flags: "--client-id <id>",
          description: "BYO app client ID disambiguation",
        },
        {
          flags: "--callback-transport <transport>",
          description: `How the OAuth callback is delivered after authorization. Use "loopback" when oauth connection is initiated from a local client, such as the macos desktop app (starts a temporary localhost server to receive the callback — no tunnel or public URL needed). Use "gateway" when the oauth connection is initiated from a web client (routes the callback through the public ingress URL — requires ingress.publicBaseUrl to be configured).`,
          defaultValue: "loopback",
        },
      ],
      helpText: `
Arguments:
  provider   Provider name (e.g. google, slack, notion).
             Run 'assistant oauth providers list' to see available providers.

When --scopes is provided, the specified scopes replace the provider's
defaults entirely (use full scope URLs).
By default, the browser opens automatically and the command waits for
completion. Use --no-browser to print the URL instead (useful for headless
or SSH sessions).

Examples:
  $ assistant oauth connect google
  $ assistant oauth connect google --no-browser
  $ assistant oauth connect google --scopes https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events
  $ assistant oauth connect google --client-id abc123`,
    },
    {
      name: "status",
      args: "<provider>",
      description: "Show OAuth connection status for a specified provider",
      helpText: `
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
    },
    {
      name: "ping",
      args: "<provider>",
      description:
        "Verify an OAuth token is valid by hitting the provider's configured health-check endpoint",
      options: [
        {
          flags: "--account <account>",
          description: "Account identifier for multi-account",
        },
        {
          flags: "--client-id <id>",
          description: "BYO app client ID disambiguation",
        },
      ],
      helpText: `
Arguments:
  provider   Provider name (e.g. google, slack).
             Run 'assistant oauth providers list' to see available providers.

Hits the provider's configured ping URL with the stored OAuth token and
reports whether the token is valid. Use 'assistant oauth status <provider>'
to find account identifiers for --account.

Examples:
  $ assistant oauth ping google
  $ assistant oauth ping google --json
  $ assistant oauth ping google --account user@example.com`,
    },
    {
      name: "request",
      args: "<url>",
      description:
        "The recommended way to make an authenticated request to an OAuth provider (supports a curl-like interface)",
      // Options are registered imperatively in request.ts: the repeatable
      // "-H, --header" flag needs a Commander collect parser (function +
      // array default), which the declarative contract cannot express, and
      // the remaining options must keep their registration order around it.
      helpText: `
This is the first-class mechanism for making authenticated HTTP requests
to an OAuth provider. By using this CLI, you follow security best-practices
regarding how the OAuth token is used. This approach is preferred over retrieving
the token (using \`assistant oauth token\`) and making the request directly.

This command resolves the OAuth connection automatically (regardless of whether
the provider's mode is set to "managed" or "your-own") and injects tokens transparently.

URL can be absolute (https://api.x.com/2/tweets) or relative (/2/tweets).
An absolute URL sets the host and full path explicitly. A relative path is
joined onto the provider's configured default base URL — the base URL shown by
'assistant oauth providers get <provider>'. For providers whose default base
URL points at one specific service, a relative path for a different service on
the same provider will resolve against the wrong host or path and fail (often
with an opaque HTML 404). When in doubt, pass an absolute URL: it is the safe
form for any service other than the provider's default.

Note: The Authorization header is set automatically. User-supplied
-H "Authorization: ..." will be overridden by the OAuth bearer token.

Examples:
  $ assistant oauth request --provider twitter https://api.x.com/2/tweets
  $ assistant oauth request --provider google /gmail/v1/users/me/messages -G
  $ assistant oauth request --provider twitter -X POST -d '{"text":"Hello"}' https://api.x.com/2/tweets
  $ assistant oauth request --provider google https://www.googleapis.com/calendar/v3/calendars/primary/events
  $ assistant oauth request --provider slack -H "Content-Type: application/json" -d '{"channel":"C123"}' /api/chat.postMessage --json`,
    },
    {
      name: "disconnect",
      args: "<provider>",
      description:
        "Disconnect an OAuth provider and remove associated credentials",
      options: [
        {
          flags: "--account <identifier>",
          description: "Account identifier to disconnect (e.g. email address)",
        },
        {
          flags: "--connection-id <id>",
          description: "Exact connection ID to disconnect",
        },
      ],
      helpText: `
Arguments:
  provider   Provider name (e.g. google, slack, notion).
             Run 'assistant oauth providers list' to see available providers.

At most one of --account or --connection-id may be specified. Use the values
shown by 'assistant oauth status <provider>' to find the right identifier.

When a provider has multiple active connections and neither flag is given,
the command errors with a list of connections and a hint to disambiguate.

Examples:
  $ assistant oauth disconnect google
  $ assistant oauth disconnect google --account user@gmail.com
  $ assistant oauth disconnect google --connection-id conn_abc123`,
    },
    {
      name: "token",
      args: "<provider>",
      description:
        'An escape hatch to retrieve a valid OAuth access token for a provider whose mode is "your-own" for direct use.',
      options: [
        {
          flags: "--account <account>",
          description:
            "Account identifier for account disambiguation (e.g. user@gmail.com)",
        },
        {
          flags: "--client-id <id>",
          description:
            "Filter by OAuth client ID when multiple OAuth apps exist for the provider",
        },
      ],
      helpText: `
Arguments:
  provider   Provider name (e.g. google, slack).
             Run 'assistant oauth providers list' to see all available
             providers.

This command is discouraged and should be used sparingly. Only use if you
need direct access to the token (i.e. \`assistant oauth request\` is
insufficient) and you are comfortable with the security implications.

Token retrieval is only supported for providers with mode set to "your-own".
Platform-managed providers handle tokens internally — use
'assistant oauth ping <provider>' to verify connectivity or
'assistant oauth request --provider <provider> <url>' to make
authenticated requests.

Use 'assistant oauth status <provider>' to find account identifiers for
--account.

Examples:
  $ assistant oauth token google
  $ assistant oauth token twitter --json
  $ assistant oauth token google --account user@gmail.com
  $ assistant oauth token google --client-id abc123`,
    },
  ],
};
