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
import { startOAuth2Flow } from "../../security/oauth2.js";
import { setSecureKeyAsync } from "../../security/secure-keys.js";
import { log } from "../logger.js";

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
  connections
    .command("list")
    .description("List all provider connections")
    .option("--provider <p>", "Filter by provider")
    .option("--json", "Output as JSON")
    .action(async (opts: { provider?: string; json?: boolean }) => {
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
        process.stdout.write(JSON.stringify({ ok: true, connections: rows }) + "\n");
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
    });
}

// ---------------------------------------------------------------------------
// Subcommand: get
// ---------------------------------------------------------------------------

function attachGetSubcommand(connections: Command): void {
  connections
    .command("get <name>")
    .description("Show a single provider connection")
    .option("--json", "Output as JSON")
    .action(async (name: string, opts: { json?: boolean }) => {
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
        process.stdout.write(JSON.stringify({ ok: true, connection: conn }) + "\n");
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
    });
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
    if (!credential) return "--credential is required when --auth api_key";
    return { type: "api_key", credential };
  }
  if (authType === "platform") {
    if (credential) return "--credential is not accepted with --auth platform";
    return { type: "platform" };
  }
  if (authType === "none") {
    if (credential) return "--credential is not accepted with --auth none";
    return { type: "none" };
  }
  if (authType === "oauth_subscription") {
    if (!credential) return "--credential is required when --auth oauth_subscription";
    return { type: "oauth_subscription", credential };
  }
  return `Unknown auth type "${authType}". Use: api_key, platform, none, oauth_subscription`;
}

function writeCliError(msg: string, json?: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  } else {
    log.error(msg);
  }
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Subcommand: create
// ---------------------------------------------------------------------------

function attachCreateSubcommand(connections: Command): void {
  connections
    .command("create <name>")
    .description("Create a new provider connection")
    .requiredOption("--provider <p>", "Provider (anthropic|openai|gemini|ollama|...)")
    .requiredOption("--auth <type>", "Auth type: api_key|platform|none")
    .option("--credential <vault-key>", "Vault credential name (required for --auth api_key)")
    .option("--json", "Output as JSON")
    .action(
      async (
        name: string,
        opts: { provider: string; auth: string; credential?: string; json?: boolean },
      ) => {
        const authInput = buildAuthInput(opts.auth, opts.credential);
        if (typeof authInput === "string") {
          writeCliError(authInput, opts.json);
          return;
        }

        const ipcResult = await cliIpcCall<ProviderConnection>(
          "inference_provider_connections_create",
          {
            body: {
              name,
              provider: opts.provider,
              auth: authInput,
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
            `Created connection "${conn.name}" (provider=${conn.provider}, auth=${formatAuth(conn.auth)})\n`,
          );
        }
      },
    );
}

// ---------------------------------------------------------------------------
// Subcommand: update
// ---------------------------------------------------------------------------

function attachUpdateSubcommand(connections: Command): void {
  connections
    .command("update <name>")
    .description("Update a connection's auth")
    .requiredOption("--auth <type>", "Auth type: api_key|platform|none")
    .option("--credential <vault-key>", "Vault credential name (required for --auth api_key)")
    .option("--json", "Output as JSON")
    .action(
      async (
        name: string,
        opts: { auth: string; credential?: string; json?: boolean },
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
            body: { auth: authInput },
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
            `Updated connection "${name}" auth to ${formatAuth(conn.auth)}\n`,
          );
        }
      },
    );
}

// ---------------------------------------------------------------------------
// Subcommand: delete
// ---------------------------------------------------------------------------

function attachDeleteSubcommand(connections: Command): void {
  connections
    .command("delete <name>")
    .description("Delete a provider connection")
    .option("--json", "Output as JSON")
    .action(async (name: string, opts: { json?: boolean }) => {
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
    });
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
  providers
    .command("login-chatgpt")
    .description("Authenticate with ChatGPT via browser OAuth flow")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
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
    });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function attachProvidersSubcommand(inference: Command): void {
  const providers = inference
    .command("providers")
    .description("Inference provider admin commands");

  const connections = providers
    .command("connections")
    .description("Manage provider connections (auth configs for inference)");

  connections.addHelpText(
    "after",
    `
Provider connections map a name to a (provider, auth) pair.
Profiles reference connections via the 'provider_connection' field.

Canonical connections (seeded on every boot):
  anthropic-managed  → provider=anthropic, auth=platform
  openai-managed     → provider=openai,    auth=platform
  gemini-managed     → provider=gemini,    auth=platform

Examples:
  $ assistant inference providers connections list
  $ assistant inference providers connections get anthropic-managed
  $ assistant inference providers connections create anthropic-personal \\
      --provider anthropic --auth api_key --credential credential/anthropic/api_key
  $ assistant inference providers connections update anthropic-personal --auth platform
  $ assistant inference providers connections delete anthropic-personal`,
  );

  attachListSubcommand(connections);
  attachGetSubcommand(connections);
  attachCreateSubcommand(connections);
  attachUpdateSubcommand(connections);
  attachDeleteSubcommand(connections);

  attachLoginChatgptSubcommand(providers);
}
