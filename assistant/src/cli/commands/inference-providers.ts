/**
 * `assistant inference providers` CLI namespace.
 *
 * Provider-scoped admin commands:
 *
 *   `assistant inference providers <verb>`
 *     list    — list configured providers (optionally filtered by provider)
 *     get     — show a single provider entry
 *     create  — add a provider (auth derived from the provider type)
 *     update  — update a provider entry
 *     delete  — remove a provider (rejects if profiles reference it)
 *
 *   `assistant inference providers connections <verb>` is a deprecated alias
 *   of the same verbs, kept for one release.
 *
 * All subcommands delegate to the daemon via IPC using the
 * `inference_provider_connections_*` routes.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import type { OAuth2Config } from "../../security/oauth2.js";
import { subcommand } from "../lib/cli-command-help.js";
import { writeCliError } from "../lib/cli-output.js";
import { attachDefaultProviderSubcommand } from "./inference-providers-default.js";

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface AuthInfo {
  type: string;
  credential?: string;
}

interface ProviderConnection {
  name: string;
  provider: string;
  auth: AuthInfo;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatAuth(auth: AuthInfo): string {
  switch (auth.type) {
    case "api_key":
      return `api_key (credential: ${auth.credential})`;
    case "platform":
      return "platform (managed proxy)";
    case "none":
      return "none";
    case "oauth_subscription":
      return `oauth_subscription (credential: ${auth.credential})`;
    case "service_account":
      return `service_account (credential: ${auth.credential})`;
    default:
      return auth.type;
  }
}

// ---------------------------------------------------------------------------
// Auth derivation
// ---------------------------------------------------------------------------

/**
 * Derive the auth object a provider implies: keyless catalog providers
 * (`setupMode: "keyless"`, e.g. ollama) need none, the Vellum sentinel routes
 * via the platform proxy, everything else authenticates by API key. Mirrors
 * the daemon's mapping so the CLI can send full auth objects regardless of
 * daemon version. Returns the auth object, or an error message string when a
 * keyed provider has no credential.
 */
async function deriveAuthForProvider(
  provider: string,
  credential?: string,
): Promise<Record<string, unknown> | string> {
  // Deferred: pure catalog modules, imported lazily per cli/no-daemon-internals.
  const [{ PROVIDER_CATALOG }, { VELLUM_MANAGED_PROVIDER }] = await Promise.all(
    [
      import("../../providers/model-catalog.js"),
      import("../../providers/vellum-model-routing.js"),
    ],
  );
  if (provider === VELLUM_MANAGED_PROVIDER) {
    return { type: "platform" };
  }
  const entry = PROVIDER_CATALOG.find((p) => p.id === provider);
  if (entry?.setupMode === "keyless") {
    return { type: "none" };
  }
  if (provider === "openai-compatible") {
    // Custom endpoints have no fixed auth story: local servers are usually
    // keyless, hosted ones keyed. Credential presence decides.
    return credential ? { type: "api_key", credential } : { type: "none" };
  }
  if (!credential) {
    return `Provider "${provider}" authenticates by API key — pass --credential <vault-key> (or an explicit --auth override)`;
  }
  return { type: "api_key", credential };
}

/**
 * Build and validate an explicit `--auth` override from CLI flags. Returns
 * the auth object on success, or an error message string on validation
 * failure.
 */
function buildAuthInput(
  authType: string,
  credential?: string,
): Record<string, unknown> | string {
  if (authType === "api_key") {
    if (!credential) {
      return "--credential is required when --auth api_key";
    }
    return { type: "api_key", credential };
  }
  if (authType === "platform") {
    if (credential) {
      return "--credential is not accepted with --auth platform";
    }
    return { type: "platform" };
  }
  if (authType === "none") {
    if (credential) {
      return "--credential is not accepted with --auth none";
    }
    return { type: "none" };
  }
  if (authType === "oauth_subscription") {
    if (!credential) {
      return "--credential is required when --auth oauth_subscription";
    }
    return { type: "oauth_subscription", credential };
  }
  return `Unknown auth type "${authType}". Use: api_key, platform, none, oauth_subscription`;
}

/** Commander collector for a repeatable option (e.g. `--model` multiple times). */
function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Build the openai-compatible custom-provider fields (`base_url`, `models`)
 * from CLI flags, forwarded to the connection route under its exact field
 * names. The daemon stays authoritative on whether they are required/allowed;
 * the CLI only shape-forwards what the user passed.
 */
function buildCustomProviderFields(opts: {
  baseUrl?: string;
  model?: string[];
}): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (opts.baseUrl !== undefined) {
    fields.base_url = opts.baseUrl;
  }
  if (opts.model !== undefined && opts.model.length > 0) {
    fields.models = opts.model.map((id) => ({ id }));
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

function attachListSubcommand(parent: Command): void {
  subcommand(parent, "list").action(
    async (opts: { provider?: string; json?: boolean }) => {
      const ipcResult = await cliIpcCall<{ connections: ProviderConnection[] }>(
        "inference_provider_connections_list",
        {
          queryParams: opts.provider ? { provider: opts.provider } : {},
        },
      );

      if (!ipcResult.ok) {
        writeCliError(ipcResult.error ?? "Unknown error", opts.json);
        return;
      }

      const rows = ipcResult.result!.connections;

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, connections: rows }) + "\n",
        );
        return;
      }

      if (rows.length === 0) {
        process.stdout.write("No providers found.\n");
        return;
      }

      for (const conn of rows) {
        process.stdout.write(`${conn.name}  provider=${conn.provider}\n`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Subcommand: get
// ---------------------------------------------------------------------------

function attachGetSubcommand(parent: Command): void {
  subcommand(parent, "get").action(
    async (name: string, opts: { json?: boolean }) => {
      const ipcResult = await cliIpcCall<ProviderConnection>(
        "inference_provider_connections_get",
        {
          pathParams: { name },
        },
      );

      if (!ipcResult.ok) {
        writeCliError(ipcResult.error ?? "Unknown error", opts.json);
        return;
      }

      const conn = ipcResult.result!;

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, connection: conn }) + "\n",
        );
        return;
      }

      process.stdout.write(`name:     ${conn.name}\n`);
      process.stdout.write(`provider: ${conn.provider}\n`);
      process.stdout.write(`auth:     ${formatAuth(conn.auth)}\n`);
      process.stdout.write(
        `created:  ${new Date(conn.createdAt).toISOString()}\n`,
      );
      process.stdout.write(
        `updated:  ${new Date(conn.updatedAt).toISOString()}\n`,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Subcommand: create
// ---------------------------------------------------------------------------

function attachCreateSubcommand(parent: Command): void {
  // `--model` uses an array-accumulating collector, which the declarative
  // help contract cannot express — it is registered imperatively here (with
  // the trailing `--json` after it, preserving option order).
  subcommand(parent, "create")
    .option(
      "--model <id>",
      "Model id offered by this provider (repeatable; required for openai-compatible)",
      collectRepeatable,
      [] as string[],
    )
    .option("--json", "Output as JSON")
    .action(
      async (
        name: string,
        opts: {
          provider: string;
          auth?: string;
          credential?: string;
          baseUrl?: string;
          model?: string[];
          json?: boolean;
        },
      ) => {
        const authInput = opts.auth
          ? buildAuthInput(opts.auth, opts.credential)
          : await deriveAuthForProvider(opts.provider, opts.credential);
        if (typeof authInput === "string") {
          writeCliError(authInput, opts.json);
          return;
        }

        if (opts.provider === "openai-compatible" && !opts.baseUrl) {
          writeCliError(
            "--base-url is required when --provider openai-compatible",
            opts.json,
          );
          return;
        }

        const ipcResult = await cliIpcCall<ProviderConnection>(
          "inference_provider_connections_create",
          {
            body: {
              name,
              provider: opts.provider,
              auth: authInput,
              ...buildCustomProviderFields(opts),
            },
          },
        );

        if (!ipcResult.ok) {
          writeCliError(ipcResult.error ?? "Unknown error", opts.json);
          return;
        }

        const conn = ipcResult.result!;

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, connection: conn }) + "\n",
          );
        } else {
          process.stdout.write(
            `Added provider "${conn.name}" (provider=${conn.provider})\n` +
              `Verify it works: point a profile at "${conn.name}", then run: assistant inference send --profile <profile> "Reply with OK"\n`,
          );
        }
      },
    );
}

// ---------------------------------------------------------------------------
// Subcommand: update
// ---------------------------------------------------------------------------

function attachUpdateSubcommand(parent: Command): void {
  // `--model` collector registered imperatively — see the note on `create`.
  subcommand(parent, "update")
    .option(
      "--model <id>",
      "Model id offered by this provider (repeatable; openai-compatible)",
      collectRepeatable,
      [] as string[],
    )
    .option("--json", "Output as JSON")
    .action(
      async (
        name: string,
        opts: {
          auth?: string;
          credential?: string;
          baseUrl?: string;
          model?: string[];
          json?: boolean;
        },
      ) => {
        // Resolve the auth to send: explicit --auth wins; a bare --credential
        // rotates the key via derived api_key auth; with neither, re-send the
        // stored auth verbatim so base-url/model-only updates work.
        let authInput: Record<string, unknown> | string;
        if (opts.auth) {
          authInput = buildAuthInput(opts.auth, opts.credential);
        } else {
          const existing = await cliIpcCall<ProviderConnection>(
            "inference_provider_connections_get",
            { pathParams: { name } },
          );
          if (!existing.ok) {
            writeCliError(existing.error ?? "Unknown error", opts.json);
            return;
          }
          const storedAuth = existing.result!.auth;
          if (opts.credential) {
            // A bare --credential must never silently flip subscription auth
            // to api_key — subscription tokens rotate via login-chatgpt.
            if (storedAuth.type === "oauth_subscription") {
              writeCliError(
                `Provider "${name}" uses subscription auth, which --credential cannot rotate. Re-run: assistant inference providers login-chatgpt (or pass an explicit --auth to switch auth types)`,
                opts.json,
              );
              return;
            }
            authInput = { type: "api_key", credential: opts.credential };
          } else {
            authInput = storedAuth as unknown as Record<string, unknown>;
          }
        }
        if (typeof authInput === "string") {
          writeCliError(authInput, opts.json);
          return;
        }

        const ipcResult = await cliIpcCall<ProviderConnection>(
          "inference_provider_connections_update",
          {
            pathParams: { name },
            body: { auth: authInput, ...buildCustomProviderFields(opts) },
          },
        );

        if (!ipcResult.ok) {
          writeCliError(ipcResult.error ?? "Unknown error", opts.json);
          return;
        }

        const conn = ipcResult.result!;

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, connection: conn }) + "\n",
          );
        } else {
          process.stdout.write(
            `Updated provider "${name}" (auth=${formatAuth(conn.auth)})\n` +
              `Verify it works: assistant inference send --profile <profile-using-this-provider> "Reply with OK"\n`,
          );
        }
      },
    );
}

// ---------------------------------------------------------------------------
// Subcommand: delete
// ---------------------------------------------------------------------------

function attachDeleteSubcommand(parent: Command): void {
  subcommand(parent, "delete").action(
    async (name: string, opts: { json?: boolean }) => {
      const ipcResult = await cliIpcCall<{ ok: true }>(
        "inference_provider_connections_delete",
        {
          pathParams: { name },
        },
      );

      if (!ipcResult.ok) {
        writeCliError(ipcResult.error ?? "Unknown error", opts.json);
        return;
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true }) + "\n");
      } else {
        process.stdout.write(`Removed provider "${name}"\n`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// OpenAI Codex OAuth config (PKCE, no client secret)
// ---------------------------------------------------------------------------

const OPENAI_CODEX_OAUTH_CONFIG: OAuth2Config = {
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenExchangeUrl: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scopes: ["openid", "profile", "email", "offline_access"],
  scopeSeparator: " ",
  authorizeParams: { id_token_add_organizations: "true" },
};

// ---------------------------------------------------------------------------
// Subcommand: login-chatgpt
// ---------------------------------------------------------------------------

function attachLoginChatgptSubcommand(providers: Command): void {
  subcommand(providers, "login-chatgpt").action(
    async (opts: { json?: boolean }) => {
      try {
        // Deferred: loads the OAuth and secure-key graphs on demand.
        const [{ startOAuth2Flow }, { setSecureKeyAsync }] = await Promise.all([
          import("../../security/oauth2.js"),
          import("../../security/secure-keys.js"),
        ]);
        // Step 1: Run browser-based PKCE OAuth flow
        process.stdout.write("Opening browser for ChatGPT authentication...\n");
        const result = await startOAuth2Flow(
          OPENAI_CODEX_OAUTH_CONFIG,
          {
            openUrl: (url) => {
              Bun.spawn(["open", url]);
            },
          },
          {
            callbackTransport: "loopback",
            loopbackPort: 1455,
            loopbackCallbackPath: "/auth/callback",
          },
        );
        const tokens = result.tokens;

        // Step 2: Store tokens in CES
        const accessStored = await setSecureKeyAsync(
          "credential/chatgpt/access_token",
          tokens.accessToken,
        );
        if (!accessStored) {
          writeCliError("Failed to store access token", opts.json);
          return;
        }

        if (tokens.refreshToken) {
          const refreshStored = await setSecureKeyAsync(
            "credential/chatgpt/refresh_token",
            tokens.refreshToken,
          );
          if (!refreshStored) {
            writeCliError("Failed to store refresh token", opts.json);
            return;
          }
        }

        if (tokens.expiresIn) {
          const expiresAt = Math.floor(Date.now() / 1000 + tokens.expiresIn);
          await setSecureKeyAsync(
            "credential/chatgpt/expires_at",
            String(expiresAt),
          );
        }

        // Step 3: Create (or update) the provider entry via IPC
        const connectionName = "chatgpt-subscription";
        const authInput = {
          type: "oauth_subscription",
          credential: "credential/chatgpt/access_token",
        };

        // Try to update first; if the entry doesn't exist, create it.
        const updateResult = await cliIpcCall<ProviderConnection>(
          "inference_provider_connections_update",
          {
            pathParams: { name: connectionName },
            body: { auth: authInput },
          },
        );

        if (!updateResult.ok) {
          // Entry doesn't exist yet — create it
          const createResult = await cliIpcCall<ProviderConnection>(
            "inference_provider_connections_create",
            {
              body: {
                name: connectionName,
                provider: "openai",
                auth: authInput,
              },
            },
          );

          if (!createResult.ok) {
            writeCliError(
              createResult.error ?? "Failed to add the ChatGPT provider",
              opts.json,
            );
            return;
          }
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({
              ok: true,
              connection: connectionName,
              message: "ChatGPT subscription auth configured successfully",
            }) + "\n",
          );
        } else {
          process.stdout.write(
            `ChatGPT subscription auth configured successfully.\n` +
              `Provider "${connectionName}" is ready.\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeCliError(message, opts.json);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Attach the five CRUD verbs to a parent (`providers` or its alias). */
function attachCrudVerbs(parent: Command): void {
  attachListSubcommand(parent);
  attachGetSubcommand(parent);
  attachCreateSubcommand(parent);
  attachUpdateSubcommand(parent);
  attachDeleteSubcommand(parent);
}

export function attachProvidersSubcommand(inference: Command): void {
  const providers = subcommand(inference, "providers");
  attachCrudVerbs(providers);

  // Deprecated alias, kept for one release.
  const connections = subcommand(providers, "connections");
  attachCrudVerbs(connections);

  attachLoginChatgptSubcommand(providers);
  attachDefaultProviderSubcommand(providers);
}
