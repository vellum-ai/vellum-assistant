import { type Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { registerCommand } from "../../lib/register-command.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SerializedProvider {
  providerKey: string;
  displayName?: string | null;
  description?: string | null;
  supportsManagedMode?: boolean;
  managedServiceIsPaid?: boolean;
  defaultScopes?: string[];
  authUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string | null;
  dashboardUrl?: string | null;
  appType?: string | null;
  requiresClientSecret?: boolean;
  clientIdPlaceholder?: string | null;
  scopeSeparator?: string;
  tokenEndpointAuthMethod?: string | null;
  tokenExchangeBodyFormat?: string | null;
  extraParams?: unknown;
  redirectUri?: string | null;
  baseUrl?: string | null;
  userinfoUrl?: string | null;
  pingUrl?: string | null;
  pingMethod?: string | null;
  pingHeaders?: unknown;
  pingBody?: unknown;
  revokeUrl?: string | null;
  revokeBodyTemplate?: unknown;
  loopbackPort?: number | null;
  injectionTemplates?: unknown;
  identityUrl?: string | null;
  identityMethod?: string | null;
  identityHeaders?: unknown;
  identityBody?: unknown;
  identityResponsePaths?: string[] | null;
  identityFormat?: string | null;
  identityOkField?: string | null;
  availableScopes?: unknown;
  setupNotes?: string[] | unknown;
  featureFlag?: string | null;
  logoUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Text formatting helpers (non-JSON output)
// ---------------------------------------------------------------------------

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

function formatJsonValue(value: unknown, indent: string = "    "): string {
  const json = JSON.stringify(value, null, 2);
  return json
    .split("\n")
    .map((line, i) => (i === 0 ? line : indent + line))
    .join("\n");
}

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
 * --logo-url and --logo-simpleicons-slug.
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
    const trimmed = opts.logoUrl.trim();
    return trimmed === "" ? null : trimmed;
  }
  return undefined;
}

export function registerProviderCommands(oauth: Command): void {
  registerCommand(oauth, {
    name: "providers",
    transport: "ipc",
    description:
      "Fetch configured OAuth providers and register custom providers of your own",
    build: (providers) => {
      providers.addHelpText(
        "after",
        `
Providers define the protocol-level configuration for an OAuth integration:
authorization URL, token URL, default scopes, and other endpoint details.

They are seeded on startup for built-in integrations (e.g. Google, Slack,
GitHub) but can also be registered dynamically via the "register" subcommand.

Each provider is identified by a provider key (e.g. "google").`,
      );

      // -----------------------------------------------------------------------
      // providers list
      // -----------------------------------------------------------------------

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
          async (
            opts: { providerKey?: string; supportsManaged?: boolean },
            cmd: Command,
          ) => {
            const queryParams: Record<string, string> = {};
            if (opts.supportsManaged) {
              queryParams.supports_managed_mode = "true";
            }
            const r = await cliIpcCall<{
              providers: Array<Record<string, unknown>>;
            }>("oauth_providers_get", {
              queryParams,
            });

            if (!r.ok) return exitFromIpcResult(r);

            // The route returns snake_case summaries; map to camelCase for
            // display consistency with the existing CLI contract.
            let rows: SerializedProvider[] = (r.result?.providers ?? []).map(
              (p) => ({
                providerKey: p.provider_key as string,
                displayName: p.display_name as string | null,
                description: p.description as string | null,
                supportsManagedMode: p.supports_managed_mode as boolean,
                managedServiceIsPaid: p.managed_service_is_paid as boolean,
                requiresClientSecret: p.requires_client_secret as boolean,
                logoUrl: p.logo_url as string | null,
                dashboardUrl: p.dashboard_url as string | null,
                clientIdPlaceholder: p.client_id_placeholder as string | null,
                featureFlag: p.feature_flag as string | null,
              }),
            );

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

            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, rows);
            } else {
              const lines = rows.map(formatProviderSummary);
              process.stdout.write(
                `${rows.length} provider(s):\n\n${lines.join("\n\n")}\n`,
              );
            }
          },
        );

      // -----------------------------------------------------------------------
      // providers get <provider-key>
      // -----------------------------------------------------------------------

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
        .action(async (provider: string, _opts: unknown, cmd: Command) => {
          const r = await cliIpcCall<{ provider: SerializedProvider }>(
            "oauth_providers_by_providerKey_get",
            { pathParams: { providerKey: provider } },
          );

          if (!r.ok) {
            if (r.statusCode === 404) {
              writeOutput(cmd, {
                ok: false,
                error: `Provider not found: "${provider}". Run 'assistant oauth providers list' to see all registered providers. To register a custom provider, run 'assistant oauth providers register --help'.`,
              });
              process.exitCode = 1;
              return;
            }
            return exitFromIpcResult(r);
          }

          const parsed = r.result?.provider;
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, parsed);
          } else if (parsed) {
            process.stdout.write(formatProviderDetail(parsed) + "\n");
          }
        });

      // -----------------------------------------------------------------------
      // providers register
      // -----------------------------------------------------------------------

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
          "OAuth token refresh endpoint URL. Defaults to --token-url when omitted.",
        )
        .option("--base-url <url>", "API base URL for the service")
        .option("--userinfo-url <url>", "OpenID Connect userinfo endpoint URL")
        .option(
          "--scopes <scopes>",
          'Comma-separated default scopes (e.g. "read,write,profile")',
        )
        .option(
          "--scope-separator <sep>",
          'Separator used to join scopes in the authorize URL (default: " ").',
        )
        .option(
          "--token-auth-method <method>",
          'How the client authenticates at the token endpoint: "client_secret_post" or "client_secret_basic"',
        )
        .option(
          "--token-exchange-body-format <format>",
          'Body encoding for the token exchange request: "form" (default) or "json"',
          "form",
        )
        .option(
          "--ping-url <url>",
          "Health-check endpoint URL for token validation",
        )
        .option(
          "--ping-method <method>",
          "HTTP method for the ping endpoint: GET (default) or POST",
        )
        .option(
          "--ping-headers <json>",
          "JSON object of extra headers for the ping request",
        )
        .option(
          "--ping-body <json>",
          "JSON body to send with the ping request",
        )
        .option(
          "--revoke-url <url>",
          "OAuth token revocation endpoint URL",
        )
        .option(
          "--revoke-body-template <json>",
          "JSON object body template for the revoke request",
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
          "URL to the provider's logo image. Mutually exclusive with --logo-simpleicons-slug.",
        )
        .option(
          "--logo-simpleicons-slug <slug>",
          'Simple Icons slug (e.g. "notion"). Mutually exclusive with --logo-url.',
        )
        .option(
          "--client-id-placeholder <text>",
          "Placeholder text shown in the client ID input field",
        )
        .option(
          "--no-client-secret",
          "Mark this provider as not requiring a client secret",
        )
        .option(
          "--loopback-port <port>",
          "Fixed port for the local OAuth callback server",
        )
        .option(
          "--injection-templates <json>",
          "JSON array of token injection templates",
        )
        .option(
          "--app-type <type>",
          'What the provider calls its OAuth apps (e.g. "OAuth App")',
        )
        .option(
          "--identity-url <url>",
          "Identity verification endpoint URL",
        )
        .option(
          "--identity-method <method>",
          "HTTP method for the identity endpoint: GET (default) or POST",
        )
        .option(
          "--identity-headers <json>",
          "JSON object of extra headers for the identity request",
        )
        .option(
          "--identity-body <body>",
          "JSON body to send with the identity request",
        )
        .option(
          "--identity-response-paths <paths>",
          "Comma-separated dot-notation paths to extract identity from the response",
        )
        .option(
          "--identity-format <template>",
          "Format template for the extracted identity",
        )
        .option(
          "--identity-ok-field <field>",
          "Dot-notation path to a boolean field that must be truthy for the response to be valid",
        )
        .option(
          "--setup-notes <json>",
          "JSON array of setup instruction notes shown during guided setup",
        )
        .option(
          "--available-scopes <value>",
          "Available scopes: either a JSON array of {scope, description?} objects or a URL",
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
      --scopes read,write --json`,
        )
        .action(
          async (
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

              const body: Record<string, unknown> = {
                provider_key: opts.providerKey,
                auth_url: opts.authUrl,
                token_url: opts.tokenUrl,
              };

              if (opts.refreshUrl !== undefined)
                body.refresh_url = opts.refreshUrl;
              if (opts.baseUrl !== undefined) body.base_url = opts.baseUrl;
              if (opts.userinfoUrl !== undefined)
                body.userinfo_url = opts.userinfoUrl;
              body.default_scopes = opts.scopes ? opts.scopes.split(",") : [];
              if (opts.scopeSeparator !== undefined)
                body.scope_separator = opts.scopeSeparator;
              if (opts.tokenAuthMethod !== undefined)
                body.token_endpoint_auth_method = opts.tokenAuthMethod;
              if (opts.tokenExchangeBodyFormat !== undefined)
                body.token_exchange_body_format = opts.tokenExchangeBodyFormat;
              if (opts.pingUrl !== undefined) body.ping_url = opts.pingUrl;
              if (opts.pingMethod !== undefined)
                body.ping_method = opts.pingMethod;
              if (opts.pingHeaders !== undefined)
                body.ping_headers = JSON.parse(opts.pingHeaders);
              if (opts.pingBody !== undefined)
                body.ping_body = JSON.parse(opts.pingBody);
              if (opts.revokeUrl !== undefined) body.revoke_url = opts.revokeUrl;
              if (opts.revokeBodyTemplate !== undefined)
                body.revoke_body_template = JSON.parse(opts.revokeBodyTemplate);
              if (opts.displayName !== undefined)
                body.display_name = opts.displayName;
              if (opts.description !== undefined)
                body.description = opts.description;
              if (opts.dashboardUrl !== undefined)
                body.dashboard_url = opts.dashboardUrl;
              if (resolvedLogoUrl !== undefined)
                body.logo_url = resolvedLogoUrl;
              if (opts.clientIdPlaceholder !== undefined)
                body.client_id_placeholder = opts.clientIdPlaceholder;
              body.requires_client_secret = opts.clientSecret;
              if (opts.loopbackPort !== undefined)
                body.loopback_port = parseInt(opts.loopbackPort, 10);
              if (opts.injectionTemplates !== undefined)
                body.injection_templates = JSON.parse(opts.injectionTemplates);
              if (opts.appType !== undefined) body.app_type = opts.appType;
              if (opts.identityUrl !== undefined)
                body.identity_url = opts.identityUrl;
              if (opts.identityMethod !== undefined)
                body.identity_method = opts.identityMethod;
              if (opts.identityHeaders !== undefined)
                body.identity_headers = JSON.parse(opts.identityHeaders);
              if (opts.identityBody !== undefined)
                body.identity_body = JSON.parse(opts.identityBody);
              if (opts.identityResponsePaths !== undefined)
                body.identity_response_paths =
                  opts.identityResponsePaths.split(",");
              if (opts.identityFormat !== undefined)
                body.identity_format = opts.identityFormat;
              if (opts.identityOkField !== undefined)
                body.identity_ok_field = opts.identityOkField;
              if (opts.setupNotes !== undefined)
                body.setup_notes = JSON.parse(opts.setupNotes);
              if (opts.availableScopes !== undefined) {
                body.available_scopes = opts.availableScopes.startsWith("http")
                  ? opts.availableScopes
                  : JSON.parse(opts.availableScopes);
              }

              const r = await cliIpcCall<{ provider: SerializedProvider }>(
                "oauth_providers_post",
                { body },
              );

              if (!r.ok) {
                let message = r.error ?? "Unknown error";
                if (message.includes("already exists")) {
                  message += ` Run 'assistant oauth providers list' to see existing providers, or choose a different --provider-key.`;
                }
                writeOutput(cmd, { ok: false, error: message });
                process.exitCode = 1;
                return;
              }

              writeOutput(cmd, r.result?.provider);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(cmd, { ok: false, error: message });
              process.exitCode = 1;
            }
          },
        );

      // -----------------------------------------------------------------------
      // providers update <provider-key>
      // -----------------------------------------------------------------------

      providers
        .command("update <provider-key>")
        .description("Update an existing custom OAuth provider configuration")
        .option(
          "--auth-url <url>",
          "OAuth authorization endpoint URL",
        )
        .option(
          "--token-url <url>",
          "OAuth token endpoint URL",
        )
        .option(
          "--refresh-url <url>",
          "OAuth token refresh endpoint URL",
        )
        .option("--base-url <url>", "API base URL for the service")
        .option("--userinfo-url <url>", "OpenID Connect userinfo endpoint URL")
        .option(
          "--scopes <scopes>",
          'Comma-separated default scopes (e.g. "read,write,profile")',
        )
        .option(
          "--scope-separator <sep>",
          'Separator used to join scopes in the authorize URL',
        )
        .option(
          "--token-auth-method <method>",
          'How the client authenticates at the token endpoint',
        )
        .option(
          "--token-exchange-body-format <format>",
          'Body encoding for the token exchange request: "form" or "json"',
        )
        .option("--ping-url <url>", "Health-check endpoint URL")
        .option(
          "--ping-method <method>",
          "HTTP method for the ping endpoint: GET (default) or POST",
        )
        .option("--ping-headers <json>", "JSON object of extra headers for the ping request")
        .option("--ping-body <json>", "JSON body for the ping request")
        .option(
          "--revoke-url <url>",
          "OAuth token revocation endpoint URL. Pass empty string to clear.",
        )
        .option(
          "--revoke-body-template <json>",
          "JSON object body template for the revoke request. Pass empty string to clear.",
        )
        .option("--display-name <name>", "Human-readable display name")
        .option("--description <text>", "Short description")
        .option("--dashboard-url <url>", "Developer console / dashboard URL")
        .option(
          "--logo-url <url>",
          "URL to the provider's logo image. Mutually exclusive with --logo-simpleicons-slug.",
        )
        .option(
          "--logo-simpleicons-slug <slug>",
          'Simple Icons slug. Mutually exclusive with --logo-url.',
        )
        .option("--client-id-placeholder <text>", "Placeholder for client ID input")
        .option("--no-client-secret", "Mark as not requiring a client secret")
        .option("--loopback-port <port>", "Fixed port for the local OAuth callback server")
        .option("--injection-templates <json>", "JSON array of token injection templates")
        .option("--app-type <type>", "What the provider calls its OAuth apps")
        .option("--identity-url <url>", "Identity verification endpoint URL")
        .option("--identity-method <method>", "HTTP method for identity endpoint")
        .option("--identity-headers <json>", "JSON object of extra headers for identity request")
        .option("--identity-body <body>", "JSON body for identity request")
        .option("--identity-response-paths <paths>", "Comma-separated dot-notation paths")
        .option("--identity-format <template>", "Format template for extracted identity")
        .option("--identity-ok-field <field>", "Dot-notation path to a boolean ok field")
        .option("--setup-notes <json>", "JSON array of setup instruction notes")
        .option("--available-scopes <value>", "Available scopes: JSON array or URL")
        .addHelpText(
          "after",
          `
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
        )
        .action(
          async (
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
              const body: Record<string, unknown> = {};

              if (opts.authUrl !== undefined) body.auth_url = opts.authUrl;
              if (opts.tokenUrl !== undefined) body.token_url = opts.tokenUrl;
              if (opts.refreshUrl !== undefined)
                body.refresh_url = opts.refreshUrl;
              if (opts.baseUrl !== undefined) body.base_url = opts.baseUrl;
              if (opts.userinfoUrl !== undefined)
                body.userinfo_url = opts.userinfoUrl;
              if (opts.scopes !== undefined)
                body.default_scopes = opts.scopes.split(",");
              if (opts.scopeSeparator !== undefined)
                body.scope_separator = opts.scopeSeparator;
              if (opts.tokenAuthMethod !== undefined)
                body.token_endpoint_auth_method = opts.tokenAuthMethod;
              if (opts.tokenExchangeBodyFormat !== undefined)
                body.token_exchange_body_format = opts.tokenExchangeBodyFormat;
              if (opts.pingUrl !== undefined) body.ping_url = opts.pingUrl;
              if (opts.pingMethod !== undefined)
                body.ping_method = opts.pingMethod;
              if (opts.pingHeaders !== undefined)
                body.ping_headers = JSON.parse(opts.pingHeaders);
              if (opts.pingBody !== undefined)
                body.ping_body = JSON.parse(opts.pingBody);
              if (opts.revokeUrl !== undefined) {
                body.revoke_url =
                  opts.revokeUrl === "" ? null : opts.revokeUrl;
              }
              if (opts.revokeBodyTemplate !== undefined) {
                body.revoke_body_template =
                  opts.revokeBodyTemplate === ""
                    ? null
                    : JSON.parse(opts.revokeBodyTemplate);
              }
              if (opts.displayName !== undefined)
                body.display_name = opts.displayName;
              if (opts.description !== undefined)
                body.description = opts.description;
              if (opts.dashboardUrl !== undefined)
                body.dashboard_url = opts.dashboardUrl;
              if (opts.clientIdPlaceholder !== undefined)
                body.client_id_placeholder = opts.clientIdPlaceholder;

              const resolvedLogoUrl = resolveLogoUrlFromFlags(opts);
              if (resolvedLogoUrl !== undefined) {
                body.logo_url = resolvedLogoUrl;
              }

              if (cmd.getOptionValueSource("clientSecret") === "cli") {
                body.requires_client_secret = opts.clientSecret;
              }

              if (opts.loopbackPort !== undefined)
                body.loopback_port = parseInt(opts.loopbackPort, 10);
              if (opts.injectionTemplates !== undefined)
                body.injection_templates = JSON.parse(opts.injectionTemplates);
              if (opts.appType !== undefined) body.app_type = opts.appType;
              if (opts.identityUrl !== undefined)
                body.identity_url = opts.identityUrl;
              if (opts.identityMethod !== undefined)
                body.identity_method = opts.identityMethod;
              if (opts.identityHeaders !== undefined)
                body.identity_headers = JSON.parse(opts.identityHeaders);
              if (opts.identityBody !== undefined)
                body.identity_body = JSON.parse(opts.identityBody);
              if (opts.identityResponsePaths !== undefined)
                body.identity_response_paths =
                  opts.identityResponsePaths.split(",");
              if (opts.identityFormat !== undefined)
                body.identity_format = opts.identityFormat;
              if (opts.identityOkField !== undefined)
                body.identity_ok_field = opts.identityOkField;
              if (opts.setupNotes !== undefined)
                body.setup_notes = JSON.parse(opts.setupNotes);
              if (opts.availableScopes !== undefined) {
                if (opts.availableScopes === "") {
                  body.available_scopes = null;
                } else {
                  body.available_scopes =
                    opts.availableScopes.startsWith("http")
                      ? opts.availableScopes
                      : JSON.parse(opts.availableScopes);
                }
              }

              if (Object.keys(body).length === 0) {
                writeOutput(cmd, {
                  ok: false,
                  error:
                    "Nothing to update. Provide at least one option to change (e.g. --auth-url, --scopes, --display-name). Run 'assistant oauth providers update --help' for all options.",
                });
                process.exitCode = 1;
                return;
              }

              const r = await cliIpcCall<{ provider: SerializedProvider }>(
                "oauth_providers_by_providerKey_patch",
                { pathParams: { providerKey: provider }, body },
              );

              if (!r.ok) {
                writeOutput(cmd, {
                  ok: false,
                  error: r.error ?? "Unknown error",
                });
                process.exitCode = 1;
                return;
              }

              writeOutput(cmd, r.result?.provider);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(cmd, { ok: false, error: message });
              process.exitCode = 1;
            }
          },
        );

      // -----------------------------------------------------------------------
      // providers delete <provider-key>
      // -----------------------------------------------------------------------

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
            const r = await cliIpcCall<{
              ok: boolean;
              deleted: {
                provider: number;
                apps: number;
                connections: number;
              };
            }>("oauth_providers_by_providerKey_delete", {
              pathParams: { providerKey: provider },
              body: { force: opts.force ?? false },
            });

            if (!r.ok) {
              writeOutput(cmd, {
                ok: false,
                error: r.error ?? "Unknown error",
              });
              process.exitCode = 1;
              return;
            }

            if (!shouldOutputJson(cmd)) {
              log.info(`Deleted provider: ${provider}`);
            }

            writeOutput(cmd, r.result);
          },
        );
    },
  });
}
