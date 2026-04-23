import { type Command } from "commander";

import { loadConfig } from "../../../config/loader.js";
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
import {
  type SerializedProvider,
  serializeProvider,
} from "../../../oauth/provider-serializer.js";
import { isProviderVisible } from "../../../oauth/provider-visibility.js";
import { SEEDED_PROVIDER_KEYS } from "../../../oauth/seed-providers.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

const LOOPBACK_CALLBACK_PATH = "/oauth/callback";

// ---------------------------------------------------------------------------
// Text formatting helpers (non-JSON output)
// ---------------------------------------------------------------------------

/**
 * Format available scopes for text output.
 * Returns a single-line string for URLs, or a multi-line bullet list for
 * structured scope arrays.
 */
function formatAvailableScopes(
  availableScopes: unknown,
  indent: string = "    ",
): string | null {
  if (!availableScopes) return null;
  if (typeof availableScopes === "string") return availableScopes;
  if (Array.isArray(availableScopes)) {
    return (
      "\n" +
      (availableScopes as Array<{ scope: string; description?: string }>)
        .map(
          (s) =>
            `${indent}- ${s.scope}${s.description ? ` — ${s.description}` : ""}`,
        )
        .join("\n")
    );
  }
  return null;
}

/** Render a single provider as a concise summary line for `list`. */
function formatProviderSummary(p: SerializedProvider): string {
  const name = p.displayName ?? p.providerKey;
  const desc = p.description ? ` — ${p.description}` : "";
  const managed = p.supportsManagedMode ? " [managed]" : "";
  const scopes =
    (p.defaultScopes as string[])?.length > 0
      ? `  Scopes: ${(p.defaultScopes as string[]).join(", ")}`
      : "";
  return (
    `${p.providerKey} (${name})${desc}${managed}` +
    `${scopes ? "\n" + scopes : ""}` +
    `\n  Run \`assistant oauth providers get ${p.providerKey}\` for full details.`
  );
}

/** Format a JSON value as indented text for `get` detail output. */
function formatJsonValue(value: unknown, indent: string = "    "): string {
  const json = JSON.stringify(value, null, 2);
  return json
    .split("\n")
    .map((line, i) => (i === 0 ? line : indent + line))
    .join("\n");
}

/** Render a single provider as structured text for `get` with all fields. */
function formatProviderDetail(p: SerializedProvider): string {
  const lines: string[] = [];
  const name = p.displayName ?? p.providerKey;
  lines.push(`${p.providerKey} (${name})`);
  if (p.description) lines.push(`  Description: ${p.description}`);
  if (p.supportsManagedMode) lines.push(`  Managed mode: yes`);
  if (p.managedServiceIsPaid) lines.push(`  Managed service is paid: yes`);
  if (p.dashboardUrl) lines.push(`  Dashboard: ${p.dashboardUrl}`);
  if (p.appType) lines.push(`  App type: ${p.appType}`);
  lines.push(
    `  Requires client secret: ${p.requiresClientSecret ? "yes" : "no"}`,
  );
  if (p.clientIdPlaceholder)
    lines.push(`  Client ID format: ${p.clientIdPlaceholder}`);
  lines.push(`  Auth URL: ${p.authUrl}`);
  lines.push(`  Token URL: ${p.tokenUrl}`);
  if (p.refreshUrl) lines.push(`  Refresh URL: ${p.refreshUrl}`);
  if (p.tokenEndpointAuthMethod)
    lines.push(`  Token auth method: ${p.tokenEndpointAuthMethod}`);
  if (p.tokenExchangeBodyFormat && p.tokenExchangeBodyFormat !== "form")
    lines.push(`  Token exchange body format: ${p.tokenExchangeBodyFormat}`);
  if ((p.defaultScopes as string[])?.length > 0)
    lines.push(`  Default scopes: ${(p.defaultScopes as string[]).join(", ")}`);
  const avail = formatAvailableScopes(p.availableScopes);
  if (avail) lines.push(`  Available scopes: ${avail}`);
  if (p.scopeSeparator && p.scopeSeparator !== " ")
    lines.push(`  Scope separator: "${p.scopeSeparator}"`);
  if (p.extraParams)
    lines.push(`  Authorize params: ${formatJsonValue(p.extraParams)}`);
  if (p.redirectUri) lines.push(`  Redirect URI: ${p.redirectUri}`);
  if (p.loopbackPort) lines.push(`  Loopback port: ${p.loopbackPort}`);
  if (p.baseUrl) lines.push(`  Base URL: ${p.baseUrl}`);
  if (p.userinfoUrl) lines.push(`  Userinfo URL: ${p.userinfoUrl}`);
  if (p.pingUrl) lines.push(`  Ping URL: ${p.pingUrl}`);
  if (p.pingMethod) lines.push(`  Ping method: ${p.pingMethod}`);
  if (p.pingHeaders)
    lines.push(`  Ping headers: ${formatJsonValue(p.pingHeaders)}`);
  if (p.pingBody) lines.push(`  Ping body: ${formatJsonValue(p.pingBody)}`);
  if (p.revokeUrl) lines.push(`  Revoke URL: ${p.revokeUrl}`);
  if (p.revokeBodyTemplate)
    lines.push(
      `  Revoke body template: ${formatJsonValue(p.revokeBodyTemplate)}`,
    );
  if (p.injectionTemplates)
    lines.push(
      `  Injection templates: ${formatJsonValue(p.injectionTemplates)}`,
    );
  if (p.identityUrl) lines.push(`  Identity URL: ${p.identityUrl}`);
  if (p.identityMethod) lines.push(`  Identity method: ${p.identityMethod}`);
  if (p.identityHeaders)
    lines.push(`  Identity headers: ${formatJsonValue(p.identityHeaders)}`);
  if (p.identityBody)
    lines.push(`  Identity body: ${formatJsonValue(p.identityBody)}`);
  if (p.identityResponsePaths)
    lines.push(
      `  Identity response paths: ${(p.identityResponsePaths as string[]).join(", ")}`,
    );
  if (p.identityFormat) lines.push(`  Identity format: ${p.identityFormat}`);
  if (p.identityOkField)
    lines.push(`  Identity ok field: ${p.identityOkField}`);
  if (p.setupNotes) {
    if (Array.isArray(p.setupNotes)) {
      lines.push(
        `  Setup notes:\n${(p.setupNotes as string[]).map((n) => `    - ${n}`).join("\n")}`,
      );
    } else {
      lines.push(`  Setup notes: ${formatJsonValue(p.setupNotes)}`);
    }
  }
  if (p.featureFlag) lines.push(`  Feature flag: ${p.featureFlag}`);
  if (p.logoUrl) lines.push(`  Logo: ${p.logoUrl}`);
  lines.push(`  Created: ${p.createdAt}`);
  lines.push(`  Updated: ${p.updatedAt}`);
  return lines.join("\n");
}

/**
 * Resolve a logo URL from CLI flags, enforcing mutual exclusion between
 * --logo-url and --logo-simpleicons-slug. Returns:
 *   - `undefined` when neither flag is set (caller should leave the field unchanged)
 *   - `null` when `--logo-url ""` is passed (clear the stored value)
 *   - a non-empty string URL otherwise
 * Throws when both flags are set simultaneously.
 */
function resolveLogoUrlFromFlags(opts: {
  logoUrl?: string;
  logoSimpleiconsSlug?: string;
}): string | null | undefined {
  if (opts.logoUrl !== undefined && opts.logoSimpleiconsSlug !== undefined) {
    throw new Error(
      "--logo-url and --logo-simpleicons-slug are mutually exclusive. Provide at most one.",
    );
  }
  if (opts.logoSimpleiconsSlug !== undefined) {
    const slug = opts.logoSimpleiconsSlug.trim();
    if (!slug) {
      throw new Error("--logo-simpleicons-slug cannot be empty.");
    }
    return `https://cdn.simpleicons.org/${encodeURIComponent(slug)}`;
  }
  if (opts.logoUrl !== undefined) {
    // Trim whitespace so copy-paste-padded URLs don't fail to parse on the
    // client. Empty string (after trimming) clears the stored value
    // (matches --revoke-url semantics documented in the `update` command
    // help text).
    const trimmed = opts.logoUrl.trim();
    return trimmed === "" ? null : trimmed;
  }
  return undefined;
}

/**
 * Resolve the redirect URI for a provider based on its loopback port.
 *
 * Resolves the loopback redirect URI for display purposes. Gateway
 * redirect URIs are resolved dynamically at connect time.
 */
function resolveRedirectUri(loopbackPort: number | null): string | null {
  if (!loopbackPort) {
    // No fixed port — loopback still works at runtime with an OS-assigned
    // port, but we can't predict the redirect URI ahead of time.  Return
    // a sentinel so callers know the transport is loopback-dynamic rather
    // than unsupported.
    return "http://localhost:<dynamic>/oauth/callback";
  }
  return `http://localhost:${loopbackPort}${LOOPBACK_CALLBACK_PATH}`;
}

/** Serialize a provider row with the CLI-resolved redirect URI. */
function parseProviderRow(row: ReturnType<typeof getProvider>) {
  if (!row) return row;
  return serializeProvider(row, {
    redirectUri: resolveRedirectUri(row.loopbackPort),
  });
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
    .option(
      "--supports-managed",
      "Only show providers that support managed mode",
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
  $ assistant oauth providers list --provider-key notion --json
  $ assistant oauth providers list --supports-managed
  $ assistant oauth providers list --supports-managed --json`,
    )
    .action(
      (
        opts: { providerKey?: string; supportsManaged?: boolean },
        cmd: Command,
      ) => {
        try {
          const config = loadConfig();
          let allProviders = listProviders();
          allProviders = allProviders.filter((r) =>
            isProviderVisible(r, config),
          );
          let rows = allProviders.map(parseProviderRow);

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

          if (opts.supportsManaged) {
            rows = rows.filter((r) => r && r.supportsManagedMode);
          }

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, rows);
          } else {
            const validRows = rows.filter(
              (r): r is NonNullable<typeof r> => r != null,
            );
            const lines = validRows.map(formatProviderSummary);
            process.stdout.write(
              `${validRows.length} provider(s):\n\n${lines.join("\n\n")}\n`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );

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
default scopes, available scopes, and extra parameters. Exits with code 1
if the provider key is not found.

Examples:
  $ assistant oauth providers get google
  $ assistant oauth providers get twitter --json`,
    )
    .action((provider: string, _opts: unknown, cmd: Command) => {
      try {
        const row = getProvider(provider);

        if (!row) {
          writeOutput(cmd, {
            ok: false,
            error: `Provider not found: "${provider}". Run 'assistant oauth providers list' to see all registered providers. To register a custom provider, run 'assistant oauth providers register --help'.`,
          });
          process.exitCode = 1;
          return;
        }

        if (!isProviderVisible(row, loadConfig())) {
          writeOutput(cmd, {
            ok: false,
            error: `Provider not found: "${provider}". Run 'assistant oauth providers list' to see all registered providers. To register a custom provider, run 'assistant oauth providers register --help'.`,
          });
          process.exitCode = 1;
          return;
        }

        const parsed = parseProviderRow(row);
        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, parsed);
        } else if (parsed) {
          process.stdout.write(formatProviderDetail(parsed) + "\n");
        }
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
    .option(
      "--refresh-url <url>",
      "OAuth token refresh endpoint URL. Defaults to --token-url when omitted. Set this when the provider uses a different endpoint for the refresh_token grant than for the authorization_code grant.",
    )
    .option("--base-url <url>", "API base URL for the service")
    .option("--userinfo-url <url>", "OpenID Connect userinfo endpoint URL")
    .option(
      "--scopes <scopes>",
      'Comma-separated default scopes (e.g. "read,write,profile")',
    )
    .option(
      "--scope-separator <sep>",
      'Separator used to join scopes in the authorize URL (default: " "). Use "," for providers like Linear that expect comma-separated scopes.',
    )
    .option(
      "--token-auth-method <method>",
      'How the client authenticates at the token endpoint: "client_secret_post" or "client_secret_basic"',
    )
    .option(
      "--token-exchange-body-format <format>",
      'Body encoding for the token exchange request: "form" (application/x-www-form-urlencoded, default) or "json" (application/json)',
      "form",
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
      "--revoke-url <url>",
      'OAuth token revocation endpoint URL. Called best-effort during disconnect to invalidate the access token upstream (e.g. "https://oauth2.googleapis.com/revoke"). When omitted, disconnect is local-only — the upstream token is left valid until it naturally expires.',
    )
    .option(
      "--revoke-body-template <json>",
      'JSON object body template for the revoke request, supporting {access_token} and {client_id} substitution (e.g. \'{"token":"{access_token}","client_id":"{client_id}"}\'). The body is form-encoded and POSTed to --revoke-url.',
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
      "--logo-url <url>",
      "URL to the provider's logo image (SVG or PNG). Mutually exclusive with --logo-simpleicons-slug.",
    )
    .option(
      "--logo-simpleicons-slug <slug>",
      'Simple Icons slug (e.g. "notion", "linear"). Resolves to https://cdn.simpleicons.org/<slug>. Mutually exclusive with --logo-url.',
    )
    .option(
      "--client-id-placeholder <text>",
      "Placeholder text shown in the client ID input field",
    )
    .option(
      "--no-client-secret",
      "Mark this provider as not requiring a client secret (default: required)",
    )
    .option(
      "--loopback-port <port>",
      "Fixed port for the local OAuth callback server (e.g. 17322). When set, the redirect URI is http://localhost:<port>/oauth/callback",
    )
    .option(
      "--injection-templates <json>",
      'JSON array of token injection templates — each with hostPattern, injectionType, headerName, valuePrefix (e.g. \'[{"hostPattern":"api.example.com","injectionType":"header","headerName":"Authorization","valuePrefix":"Bearer "}]\')',
    )
    .option(
      "--app-type <type>",
      'What the provider calls its OAuth apps (e.g. "OAuth App", "Desktop app", "Public integration")',
    )
    .option(
      "--identity-url <url>",
      "Identity verification endpoint URL — called after OAuth to identify the connected account",
    )
    .option(
      "--identity-method <method>",
      "HTTP method for the identity endpoint: GET (default) or POST",
    )
    .option(
      "--identity-headers <json>",
      'JSON object of extra headers for the identity request (e.g. \'{"Notion-Version":"2022-06-28"}\')',
    )
    .option(
      "--identity-body <body>",
      'JSON body to send with the identity request (e.g. \'{"query":"{ viewer { email } }"}\')',
    )
    .option(
      "--identity-response-paths <paths>",
      'Comma-separated dot-notation paths to extract identity from the response (e.g. "email,name,person.email")',
    )
    .option(
      "--identity-format <template>",
      'Format template for the extracted identity using ${pathName} tokens from --identity-response-paths (e.g. "@${login}" or "@${user} (${team})")',
    )
    .option(
      "--identity-ok-field <field>",
      'Dot-notation path to a boolean field that must be truthy for the response to be considered valid (e.g. "ok")',
    )
    .option(
      "--setup-notes <json>",
      'JSON array of setup instruction notes shown during guided setup (e.g. \'["Enable the Gmail API","Add test users"]\')',
    )
    .option(
      "--available-scopes <value>",
      "Available scopes: either a JSON array of {scope, description?} objects or a URL to the provider scope docs",
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

Token injection templates control how the OAuth access token is injected
into outgoing HTTP requests matched by host pattern. Identity config
defines how the assistant verifies the connected account after OAuth.

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
      --ping-body '{"query":"{ viewer { id } }"}'
  $ assistant oauth providers register \\
      --provider-key linear-custom \\
      --auth-url https://linear.app/oauth/authorize \\
      --token-url https://api.linear.app/oauth/token \\
      --scopes read,write \\
      --scope-separator ","
  $ assistant oauth providers register \\
      --provider-key split-grants \\
      --auth-url https://example.com/oauth/authorize \\
      --token-url https://example.com/oauth/token \\
      --refresh-url https://example.com/oauth/refresh
  $ assistant oauth providers register \\
      --provider-key my-api \\
      --auth-url https://example.com/auth \\
      --token-url https://example.com/token \\
      --loopback-port 17400 \\
      --injection-templates '[{"hostPattern":"api.example.com","injectionType":"header","headerName":"Authorization","valuePrefix":"Bearer "}]' \\
      --identity-url https://api.example.com/me \\
      --identity-response-paths email,name
  $ assistant oauth providers register \\
      --provider-key custom-revokable \\
      --auth-url https://example.com/oauth/authorize \\
      --token-url https://example.com/oauth/token \\
      --revoke-url https://example.com/oauth/revoke \\
      --revoke-body-template '{"token":"{access_token}","client_id":"{client_id}"}'
  $ assistant oauth providers register \\
      --provider-key notion-custom \\
      --auth-url https://api.notion.com/v1/oauth/authorize \\
      --token-url https://api.notion.com/v1/oauth/token \\
      --token-exchange-body-format json \\
      --logo-simpleicons-slug notion`,
    )
    .action(
      (
        opts: {
          providerKey: string;
          authUrl: string;
          tokenUrl: string;
          refreshUrl?: string;
          baseUrl?: string;
          userinfoUrl?: string;
          scopes?: string;
          scopeSeparator?: string;
          tokenAuthMethod?: string;
          tokenExchangeBodyFormat?: string;
          pingUrl?: string;
          pingMethod?: string;
          pingHeaders?: string;
          pingBody?: string;
          revokeUrl?: string;
          revokeBodyTemplate?: string;
          displayName?: string;
          description?: string;
          dashboardUrl?: string;
          logoUrl?: string;
          logoSimpleiconsSlug?: string;
          clientIdPlaceholder?: string;
          clientSecret: boolean;
          loopbackPort?: string;
          injectionTemplates?: string;
          appType?: string;
          identityUrl?: string;
          identityMethod?: string;
          identityHeaders?: string;
          identityBody?: string;
          identityResponsePaths?: string;
          identityFormat?: string;
          identityOkField?: string;
          setupNotes?: string;
          availableScopes?: string;
        },
        cmd: Command,
      ) => {
        try {
          const resolvedLogoUrl = resolveLogoUrlFromFlags(opts);
          if (resolvedLogoUrl === null) {
            throw new Error(
              "Cannot clear logo_url with empty --logo-url during registration. Omit the flag instead.",
            );
          }

          const row = registerProvider({
            provider: opts.providerKey,
            authorizeUrl: opts.authUrl,
            tokenExchangeUrl: opts.tokenUrl,
            refreshUrl: opts.refreshUrl,
            baseUrl: opts.baseUrl,
            userinfoUrl: opts.userinfoUrl,
            defaultScopes: opts.scopes ? opts.scopes.split(",") : [],
            availableScopes: opts.availableScopes
              ? opts.availableScopes.startsWith("http")
                ? opts.availableScopes
                : JSON.parse(opts.availableScopes)
              : undefined,
            scopeSeparator: opts.scopeSeparator,
            tokenEndpointAuthMethod: opts.tokenAuthMethod,
            tokenExchangeBodyFormat: opts.tokenExchangeBodyFormat,
            pingUrl: opts.pingUrl,
            pingMethod: opts.pingMethod,
            pingHeaders: opts.pingHeaders
              ? JSON.parse(opts.pingHeaders)
              : undefined,
            pingBody: opts.pingBody ? JSON.parse(opts.pingBody) : undefined,
            revokeUrl: opts.revokeUrl,
            revokeBodyTemplate: opts.revokeBodyTemplate
              ? JSON.parse(opts.revokeBodyTemplate)
              : undefined,
            displayLabel: opts.displayName,
            description: opts.description,
            dashboardUrl: opts.dashboardUrl,
            logoUrl: resolvedLogoUrl,
            clientIdPlaceholder: opts.clientIdPlaceholder,
            requiresClientSecret: opts.clientSecret ? 1 : 0,
            loopbackPort: opts.loopbackPort
              ? parseInt(opts.loopbackPort, 10)
              : undefined,
            injectionTemplates: opts.injectionTemplates
              ? JSON.parse(opts.injectionTemplates)
              : undefined,
            appType: opts.appType,
            identityUrl: opts.identityUrl,
            identityMethod: opts.identityMethod,
            identityHeaders: opts.identityHeaders
              ? JSON.parse(opts.identityHeaders)
              : undefined,
            identityBody: opts.identityBody
              ? JSON.parse(opts.identityBody)
              : undefined,
            identityResponsePaths: opts.identityResponsePaths
              ? opts.identityResponsePaths.split(",")
              : undefined,
            identityFormat: opts.identityFormat,
            identityOkField: opts.identityOkField,
            setupNotes: opts.setupNotes
              ? JSON.parse(opts.setupNotes)
              : undefined,
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
    .option(
      "--refresh-url <url>",
      "OAuth token refresh endpoint URL. Defaults to --token-url when omitted. Set this when the provider uses a different endpoint for the refresh_token grant than for the authorization_code grant.",
    )
    .option("--base-url <url>", "API base URL for the service")
    .option("--userinfo-url <url>", "OpenID Connect userinfo endpoint URL")
    .option(
      "--scopes <scopes>",
      'Comma-separated default scopes (e.g. "read,write,profile")',
    )
    .option(
      "--scope-separator <sep>",
      'Separator used to join scopes in the authorize URL (default: " "). Use "," for providers like Linear that expect comma-separated scopes.',
    )
    .option(
      "--token-auth-method <method>",
      'How the client authenticates at the token endpoint: "client_secret_post" or "client_secret_basic"',
    )
    .option(
      "--token-exchange-body-format <format>",
      'Body encoding for the token exchange request: "form" (application/x-www-form-urlencoded, default) or "json" (application/json)',
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
      "--revoke-url <url>",
      "OAuth token revocation endpoint URL. Called best-effort during disconnect to invalidate the access token upstream. Pass an empty string to clear.",
    )
    .option(
      "--revoke-body-template <json>",
      "JSON object body template for the revoke request, supporting {access_token} and {client_id} substitution. Pass an empty string to clear.",
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
      "--logo-url <url>",
      "URL to the provider's logo image (SVG or PNG). Mutually exclusive with --logo-simpleicons-slug.",
    )
    .option(
      "--logo-simpleicons-slug <slug>",
      'Simple Icons slug (e.g. "notion", "linear"). Resolves to https://cdn.simpleicons.org/<slug>. Mutually exclusive with --logo-url.',
    )
    .option(
      "--client-id-placeholder <text>",
      "Placeholder text shown in the client ID input field",
    )
    .option(
      "--no-client-secret",
      "Mark this provider as not requiring a client secret (default: required)",
    )
    .option(
      "--loopback-port <port>",
      "Fixed port for the local OAuth callback server (e.g. 17322). When set, the redirect URI is http://localhost:<port>/oauth/callback",
    )
    .option(
      "--injection-templates <json>",
      'JSON array of token injection templates — each with hostPattern, injectionType, headerName, valuePrefix (e.g. \'[{"hostPattern":"api.example.com","injectionType":"header","headerName":"Authorization","valuePrefix":"Bearer "}]\')',
    )
    .option(
      "--app-type <type>",
      'What the provider calls its OAuth apps (e.g. "OAuth App", "Desktop app", "Public integration")',
    )
    .option(
      "--identity-url <url>",
      "Identity verification endpoint URL — called after OAuth to identify the connected account",
    )
    .option(
      "--identity-method <method>",
      "HTTP method for the identity endpoint: GET (default) or POST",
    )
    .option(
      "--identity-headers <json>",
      'JSON object of extra headers for the identity request (e.g. \'{"Notion-Version":"2022-06-28"}\')',
    )
    .option(
      "--identity-body <body>",
      'JSON body to send with the identity request (e.g. \'{"query":"{ viewer { email } }"}\')',
    )
    .option(
      "--identity-response-paths <paths>",
      'Comma-separated dot-notation paths to extract identity from the response (e.g. "email,name,person.email")',
    )
    .option(
      "--identity-format <template>",
      'Format template for the extracted identity using ${pathName} tokens from --identity-response-paths (e.g. "@${login}" or "@${user} (${team})")',
    )
    .option(
      "--identity-ok-field <field>",
      'Dot-notation path to a boolean field that must be truthy for the response to be considered valid (e.g. "ok")',
    )
    .option(
      "--setup-notes <json>",
      'JSON array of setup instruction notes shown during guided setup (e.g. \'["Enable the Gmail API","Add test users"]\')',
    )
    .option(
      "--available-scopes <value>",
      "Available scopes: either a JSON array of {scope, description?} objects or a URL to the provider scope docs",
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

Token injection templates control how the OAuth access token is injected
into outgoing HTTP requests matched by host pattern. Identity config
defines how the assistant verifies the connected account after OAuth.

Examples:
  $ assistant oauth providers update custom-api --display-name "My Custom API"
  $ assistant oauth providers update custom-api --scopes read,write --auth-url https://new.example.com/auth
  $ assistant oauth providers update custom-api --ping-url https://api.example.com/me --json
  $ assistant oauth providers update custom-api --scope-separator ","
  $ assistant oauth providers update custom-api --refresh-url https://example.com/oauth/refresh
  $ assistant oauth providers update custom-api \\
      --identity-url https://api.example.com/me \\
      --identity-response-paths email,name
  $ assistant oauth providers update custom-api \\
      --injection-templates '[{"hostPattern":"api.example.com","injectionType":"header","headerName":"Authorization","valuePrefix":"Bearer "}]'
  $ assistant oauth providers update custom-api \\
      --revoke-url https://api.example.com/oauth/revoke \\
      --revoke-body-template '{"token":"{access_token}"}'
  $ assistant oauth providers update custom-api --logo-simpleicons-slug notion
  $ assistant oauth providers update custom-api --logo-url ""`,
    )
    .action(
      (
        provider: string,
        opts: {
          authUrl?: string;
          tokenUrl?: string;
          refreshUrl?: string;
          baseUrl?: string;
          userinfoUrl?: string;
          scopes?: string;
          scopeSeparator?: string;
          tokenAuthMethod?: string;
          tokenExchangeBodyFormat?: string;
          pingUrl?: string;
          pingMethod?: string;
          pingHeaders?: string;
          pingBody?: string;
          revokeUrl?: string;
          revokeBodyTemplate?: string;
          displayName?: string;
          description?: string;
          dashboardUrl?: string;
          logoUrl?: string;
          logoSimpleiconsSlug?: string;
          clientIdPlaceholder?: string;
          clientSecret: boolean;
          loopbackPort?: string;
          injectionTemplates?: string;
          appType?: string;
          identityUrl?: string;
          identityMethod?: string;
          identityHeaders?: string;
          identityBody?: string;
          identityResponsePaths?: string;
          identityFormat?: string;
          identityOkField?: string;
          setupNotes?: string;
          availableScopes?: string;
        },
        cmd: Command,
      ) => {
        try {
          // Verify provider exists
          const existing = getProvider(provider);
          if (!existing) {
            writeOutput(cmd, {
              ok: false,
              error: `Provider "${provider}" not found. Run 'assistant oauth providers list' to see all registered providers.`,
            });
            process.exitCode = 1;
            return;
          }

          if (!isProviderVisible(existing, loadConfig())) {
            writeOutput(cmd, {
              ok: false,
              error: `Provider "${provider}" not found. Run 'assistant oauth providers list' to see all registered providers.`,
            });
            process.exitCode = 1;
            return;
          }

          // Block updates to built-in providers
          if (SEEDED_PROVIDER_KEYS.has(provider)) {
            writeOutput(cmd, {
              ok: false,
              error: `Cannot update built-in provider "${provider}". Built-in providers are managed by the system and reset on startup. To create a custom provider with different settings, use 'assistant oauth providers register --provider-key <your-custom-key> ...'`,
            });
            process.exitCode = 1;
            return;
          }

          // Build params object from provided options, omitting undefined values
          const params: Record<string, unknown> = {};

          if (opts.authUrl !== undefined) params.authorizeUrl = opts.authUrl;
          if (opts.tokenUrl !== undefined)
            params.tokenExchangeUrl = opts.tokenUrl;
          if (opts.refreshUrl !== undefined)
            params.refreshUrl = opts.refreshUrl;
          if (opts.baseUrl !== undefined) params.baseUrl = opts.baseUrl;
          if (opts.userinfoUrl !== undefined)
            params.userinfoUrl = opts.userinfoUrl;
          if (opts.scopes !== undefined)
            params.defaultScopes = opts.scopes.split(",");
          if (opts.scopeSeparator !== undefined)
            params.scopeSeparator = opts.scopeSeparator;
          if (opts.tokenAuthMethod !== undefined)
            params.tokenEndpointAuthMethod = opts.tokenAuthMethod;
          if (opts.tokenExchangeBodyFormat !== undefined)
            params.tokenExchangeBodyFormat = opts.tokenExchangeBodyFormat;
          if (opts.pingUrl !== undefined) params.pingUrl = opts.pingUrl;
          if (opts.pingMethod !== undefined)
            params.pingMethod = opts.pingMethod;
          if (opts.pingHeaders !== undefined)
            params.pingHeaders = JSON.parse(opts.pingHeaders);
          if (opts.pingBody !== undefined)
            params.pingBody = JSON.parse(opts.pingBody);
          if (opts.revokeUrl !== undefined) {
            // Empty string means "clear" — normalize to null so the stored
            // value matches the "disabled" semantics documented in the help
            // text. `updateProvider`'s Partial type accepts `string | null`
            // for this field so drizzle writes `null` to clear the column.
            params.revokeUrl = opts.revokeUrl === "" ? null : opts.revokeUrl;
          }
          if (opts.revokeBodyTemplate !== undefined) {
            // Empty string means "clear" — normalize to null to match --revoke-url's
            // empty-string-clear semantics documented in the help text. The
            // updateProvider type accepts `Record<string, string> | null` for this.
            params.revokeBodyTemplate =
              opts.revokeBodyTemplate === ""
                ? null
                : JSON.parse(opts.revokeBodyTemplate);
          }
          if (opts.displayName !== undefined)
            params.displayLabel = opts.displayName;
          if (opts.description !== undefined)
            params.description = opts.description;
          if (opts.dashboardUrl !== undefined)
            params.dashboardUrl = opts.dashboardUrl;
          if (opts.clientIdPlaceholder !== undefined)
            params.clientIdPlaceholder = opts.clientIdPlaceholder;

          const resolvedLogoUrl = resolveLogoUrlFromFlags(opts);
          if (resolvedLogoUrl !== undefined) {
            params.logoUrl = resolvedLogoUrl;
          }

          // Handle the negated --no-client-* flag: Commander defaults
          // opts.clientSecret to true; the negated form sets it to false.
          // Use getOptionValueSource to detect explicit user intent.
          if (cmd.getOptionValueSource("clientSecret") === "cli") {
            params.requiresClientSecret = opts.clientSecret ? 1 : 0;
          }

          if (opts.loopbackPort !== undefined)
            params.loopbackPort = parseInt(opts.loopbackPort, 10);
          if (opts.injectionTemplates !== undefined)
            params.injectionTemplates = JSON.parse(opts.injectionTemplates);
          if (opts.appType !== undefined) params.appType = opts.appType;
          if (opts.identityUrl !== undefined)
            params.identityUrl = opts.identityUrl;
          if (opts.identityMethod !== undefined)
            params.identityMethod = opts.identityMethod;
          if (opts.identityHeaders !== undefined)
            params.identityHeaders = JSON.parse(opts.identityHeaders);
          if (opts.identityBody !== undefined)
            params.identityBody = JSON.parse(opts.identityBody);
          if (opts.identityResponsePaths !== undefined)
            params.identityResponsePaths =
              opts.identityResponsePaths.split(",");
          if (opts.identityFormat !== undefined)
            params.identityFormat = opts.identityFormat;
          if (opts.identityOkField !== undefined)
            params.identityOkField = opts.identityOkField;
          if (opts.setupNotes !== undefined)
            params.setupNotes = JSON.parse(opts.setupNotes);
          if (opts.availableScopes !== undefined) {
            if (opts.availableScopes === "") {
              params.availableScopes = null;
            } else {
              params.availableScopes = opts.availableScopes.startsWith("http")
                ? opts.availableScopes
                : JSON.parse(opts.availableScopes);
            }
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

          const row = updateProvider(provider, params);

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
      async (provider: string, opts: { force?: boolean }, cmd: Command) => {
        try {
          const providerRow = getProvider(provider);
          if (!providerRow) {
            writeOutput(cmd, {
              ok: false,
              error: `Provider not found: "${provider}". Run 'assistant oauth providers list' to see all registered providers.`,
            });
            process.exitCode = 1;
            return;
          }

          if (!isProviderVisible(providerRow, loadConfig())) {
            writeOutput(cmd, {
              ok: false,
              error: `Provider not found: "${provider}". Run 'assistant oauth providers list' to see all registered providers.`,
            });
            process.exitCode = 1;
            return;
          }

          if (SEEDED_PROVIDER_KEYS.has(provider) && !opts.force) {
            log.info(
              `Note: "${provider}" is a built-in provider and will be re-created on next startup.`,
            );
          }

          const dependentApps = listApps().filter(
            (a) => a.provider === provider,
          );
          const dependentConnections = listConnections(provider);
          const appCount = dependentApps.length;
          const connCount = dependentConnections.length;

          if ((appCount > 0 || connCount > 0) && !opts.force) {
            writeOutput(cmd, {
              ok: false,
              error: `Cannot delete provider "${provider}": ${appCount} app(s) and ${connCount} connection(s) depend on it. Use --force to cascade-delete all dependent apps and connections, or remove them manually first with 'assistant oauth apps delete' and 'assistant oauth disconnect'.`,
            });
            process.exitCode = 1;
            return;
          }

          // Warn about built-in providers when --force is used
          if (SEEDED_PROVIDER_KEYS.has(provider) && opts.force) {
            log.info(
              `Note: "${provider}" is a built-in provider and will be re-created on next startup.`,
            );
          }

          // Cascade-delete connections first, then apps, then the provider.
          // Use disconnectOAuthProvider to clean up OAuth tokens from secure
          // storage in addition to deleting the connection DB row.
          for (const conn of dependentConnections) {
            const result = await disconnectOAuthProvider(
              provider,
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
          deleteProvider(provider);

          if (!shouldOutputJson(cmd)) {
            log.info(`Deleted provider: ${provider}`);
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
