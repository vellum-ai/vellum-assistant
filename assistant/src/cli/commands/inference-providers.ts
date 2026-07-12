/**
 * `assistant inference providers` CLI namespace.
 *
 * Provider-scoped admin commands. Currently exposes one subcommand:
 *
 *   `assistant inference providers connections <verb>`
 *     list    — list all connections (optionally filtered by provider)
 *     get     — show a single connection
 *     create  — create a new connection
 *     update  — update a connection's auth
 *     delete  — delete a connection (rejects if profiles reference it)
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
// Subcommand: list
// ---------------------------------------------------------------------------

function attachListSubcommand(connections: Command): void {
  subcommand(connections, "list").action(
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
        process.stdout.write("No connections found.\n");
        return;
      }

      for (const conn of rows) {
        process.stdout.write(
          `${conn.name}  provider=${conn.provider}  auth=${formatAuth(conn.auth)}\n`,
        );
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Subcommand: get
// ---------------------------------------------------------------------------

function attachGetSubcommand(connections: Command): void {
  subcommand(connections, "get").action(
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
// Auth input builder
// ---------------------------------------------------------------------------

/**
 * Build and validate auth input from CLI flags. Returns the auth object on
 * success, or an error message string on validation failure.
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
// Subcommand: create
// ---------------------------------------------------------------------------

function attachCreateSubcommand(connections: Command): void {
  // `--model` uses an array-accumulating collector, which the declarative
  // help contract cannot express — it is registered imperatively here (with
  // the trailing `--json` after it, preserving option order).
  subcommand(connections, "create")
    .option(
      "--model <id>",
      "Model id offered by this connection (repeatable; required for openai-compatible)",
      collectRepeatable,
      [] as string[],
    )
    .option("--json", "Output as JSON")
    .action(
      async (
        name: string,
        opts: {
          provider: string;
          auth: string;
          credential?: string;
          baseUrl?: string;
          model?: string[];
          json?: boolean;
        },
      ) => {
        const authInput = buildAuthInput(opts.auth, opts.credential);
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
            `Created connection "${conn.name}" (provider=${conn.provider}, auth=${formatAuth(conn.auth)})\n` +
              `Verify it works: point a profile's provider_connection at "${conn.name}", then run: assistant inference send --profile <profile> "Reply with OK"\n`,
          );
        }
      },
    );
}

// ---------------------------------------------------------------------------
// Subcommand: update
// ---------------------------------------------------------------------------

function attachUpdateSubcommand(connections: Command): void {
  // `--model` collector registered imperatively — see the note on `create`.
  subcommand(connections, "update")
    .option(
      "--model <id>",
      "Model id offered by this connection (repeatable; openai-compatible)",
      collectRepeatable,
      [] as string[],
    )
    .option("--json", "Output as JSON")
    .action(
      async (
        name: string,
        opts: {
          auth: string;
          credential?: string;
          baseUrl?: string;
          model?: string[];
          json?: boolean;
        },
      ) => {
        const authInput = buildAuthInput(opts.auth, opts.credential);
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
            `Updated connection "${name}" auth to ${formatAuth(conn.auth)}\n` +
              `Verify it works: assistant inference send --profile <profile-using-this-connection> "Reply with OK"\n`,
          );
        }
      },
    );
}

// ---------------------------------------------------------------------------
// Subcommand: delete
// ---------------------------------------------------------------------------

function attachDeleteSubcommand(connections: Command): void {
  subcommand(connections, "delete").action(
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
        process.stdout.write(`Deleted connection "${name}"\n`);
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

        // Step 3: Create (or update) provider connection via IPC
        const connectionName = "chatgpt-subscription";
        const authInput = {
          type: "oauth_subscription",
          credential: "credential/chatgpt/access_token",
        };

        // Try to update first; if the connection doesn't exist, create it.
        const updateResult = await cliIpcCall<ProviderConnection>(
          "inference_provider_connections_update",
          {
            pathParams: { name: connectionName },
            body: { auth: authInput },
          },
        );

        if (!updateResult.ok) {
          // Connection doesn't exist yet — create it
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
              createResult.error ?? "Failed to create provider connection",
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
              `Connection "${connectionName}" is ready (provider=openai, auth=oauth_subscription).\n`,
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

export function attachProvidersSubcommand(inference: Command): void {
  const providers = subcommand(inference, "providers");
  const connections = subcommand(providers, "connections");

  attachListSubcommand(connections);
  attachGetSubcommand(connections);
  attachCreateSubcommand(connections);
  attachUpdateSubcommand(connections);
  attachDeleteSubcommand(connections);

  attachLoginChatgptSubcommand(providers);
  attachDefaultProviderSubcommand(providers);
}
