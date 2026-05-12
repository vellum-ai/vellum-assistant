import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { registerCommand } from "../../lib/register-command.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AppRow {
  id: string;
  provider_key: string;
  client_id: string;
  created_at: number;
  updated_at: number;
}

/** Format an app row for CLI output, converting timestamps to ISO strings. */
function formatAppRow(row: AppRow) {
  return {
    id: row.id,
    providerKey: row.provider_key,
    clientId: row.client_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Resolve a credential path input to its full internal format.
 *
 * The primary input format is `service:field` (e.g. `google:client_secret`),
 * which is split on the **last** colon and expanded to `credential/{service}/{field}`.
 *
 * Full internal paths (`credential/…` or `oauth_app/…`) are also accepted
 * and returned as-is for backwards compatibility.
 */
function resolveCredentialPath(input: string): string {
  if (input.startsWith("credential/") || input.startsWith("oauth_app/")) {
    return input;
  }

  const lastColon = input.lastIndexOf(":");
  if (lastColon < 1 || lastColon === input.length - 1) {
    return input;
  }

  const service = input.slice(0, lastColon);
  const field = input.slice(lastColon + 1);
  return `credential/${service}/${field}`;
}

export function registerAppCommands(oauth: Command): void {
  registerCommand(oauth, {
    name: "apps",
    transport: "ipc",
    description: "Manage custom OAuth app registrations",
    build: (apps) => {
      apps.addHelpText(
        "after",
        `
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
      );

      // -----------------------------------------------------------------------
      // apps list
      // -----------------------------------------------------------------------

      apps
        .command("list")
        .description("List all OAuth app registrations")
        .option(
          "--provider-key <key>",
          "Filter by provider key (exact match). Run 'assistant oauth providers list' to see available keys.",
        )
        .addHelpText(
          "after",
          `
Returns registered OAuth apps with their provider key, client ID, and
timestamps. Output is an array of app objects.

When --provider-key is specified, only apps whose provider exactly matches
the given value are returned. Without the flag, all apps are listed.

Examples:
  $ assistant oauth apps list
  $ assistant oauth apps list --provider-key google
  $ assistant oauth apps list --provider-key slack --json`,
        )
        .action(async (opts: { providerKey?: string }, cmd: Command) => {
          if (!opts.providerKey) {
            // The IPC route requires provider_key. To support listing all
            // apps, we first need to know the providers. For simplicity
            // and backward compatibility, list providers first, then
            // aggregate.
            const provR = await cliIpcCall<{
              providers: Array<{ provider_key: string }>;
            }>("oauth_providers_get", { queryParams: {} });

            if (!provR.ok) return exitFromIpcResult(provR);

            const allRows: ReturnType<typeof formatAppRow>[] = [];
            for (const p of provR.result?.providers ?? []) {
              const r = await cliIpcCall<{
                apps: AppRow[];
              }>("oauth_apps_get", {
                queryParams: { provider_key: p.provider_key },
              });
              if (r.ok && r.result?.apps) {
                allRows.push(...r.result.apps.map(formatAppRow));
              }
            }

            if (!shouldOutputJson(cmd)) {
              log.info(`Found ${allRows.length} app(s)`);
            }
            writeOutput(cmd, allRows);
            return;
          }

          const r = await cliIpcCall<{ apps: AppRow[] }>(
            "oauth_apps_get",
            { queryParams: { provider_key: opts.providerKey } },
          );

          if (!r.ok) return exitFromIpcResult(r);

          const rows = (r.result?.apps ?? []).map(formatAppRow);

          if (!shouldOutputJson(cmd)) {
            log.info(`Found ${rows.length} app(s)`);
          }

          writeOutput(cmd, rows);
        });

      // -----------------------------------------------------------------------
      // apps get
      // -----------------------------------------------------------------------

      apps
        .command("get")
        .description(
          "Look up an OAuth app by ID, provider + client-id, or provider",
        )
        .option("--id <id>", "App ID (UUID) from 'assistant oauth apps list'")
        .option(
          "--provider <key>",
          "Provider key (e.g. google) from 'assistant oauth providers list'",
        )
        .option(
          "--client-id <id>",
          "OAuth client ID (requires --provider). Find registered client IDs via 'assistant oauth apps list'.",
        )
        .addHelpText(
          "after",
          `
Three lookup modes are supported:

  1. By app ID:
     $ assistant oauth apps get --id <uuid>

  2. By provider + client ID (exact match):
     $ assistant oauth apps get --provider google --client-id abc123

  3. By provider only (returns the most recently created app):
     $ assistant oauth apps get --provider google

At least --id or --provider must be specified.`,
        )
        .action(
          async (
            opts: { id?: string; provider?: string; clientId?: string },
            cmd: Command,
          ) => {
            if (!opts.id && !opts.provider) {
              writeOutput(cmd, {
                ok: false,
                error:
                  "Provide --id, --provider, or --provider + --client-id. Run 'assistant oauth apps list' to see all registered apps.",
              });
              process.exitCode = 1;
              return;
            }

            const queryParams: Record<string, string> = {};
            if (opts.id) queryParams.id = opts.id;
            if (opts.provider) queryParams.provider = opts.provider;
            if (opts.clientId) queryParams.client_id = opts.clientId;

            const r = await cliIpcCall<{ app: AppRow }>(
              "oauth_apps_by_query_get",
              { queryParams },
            );

            if (!r.ok) {
              if (r.statusCode === 404) {
                const lookup = opts.id
                  ? `id=${opts.id}`
                  : opts.provider && opts.clientId
                    ? `provider=${opts.provider}, clientId=${opts.clientId}`
                    : `provider=${opts.provider}`;
                writeOutput(cmd, {
                  ok: false,
                  error: `No app found for ${lookup}. Run 'assistant oauth apps list' to see registered apps, or 'assistant oauth apps upsert --help' to register a new one.`,
                });
                process.exitCode = 1;
                return;
              }
              return exitFromIpcResult(r);
            }

            const row = r.result?.app;
            writeOutput(cmd, row ? formatAppRow(row) : null);
          },
        );

      // -----------------------------------------------------------------------
      // apps upsert
      // -----------------------------------------------------------------------

      apps
        .command("upsert")
        .description("Create or return an existing OAuth app registration")
        .requiredOption(
          "--provider <key>",
          "Provider key (e.g. google) from 'assistant oauth providers list'",
        )
        .requiredOption(
          "--client-id <id>",
          "OAuth client ID from the provider's developer console",
        )
        .option(
          "--client-secret <secret>",
          "OAuth client secret (stored in credential store)",
        )
        .option(
          "--client-secret-credential-path <path>",
          "Credential reference in service:field format (e.g. google:client_secret). Mutually exclusive with --client-secret.",
        )
        .addHelpText(
          "after",
          `
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
        )
        .action(
          async (
            opts: {
              provider: string;
              clientId: string;
              clientSecret?: string;
              clientSecretCredentialPath?: string;
            },
            cmd: Command,
          ) => {
            if (opts.clientSecret && opts.clientSecretCredentialPath) {
              writeOutput(cmd, {
                ok: false,
                error:
                  "Cannot provide both --client-secret and --client-secret-credential-path",
              });
              process.exitCode = 1;
              return;
            }

            const body: Record<string, unknown> = {
              provider_key: opts.provider,
              client_id: opts.clientId,
            };

            if (opts.clientSecret) {
              body.client_secret = opts.clientSecret;
            } else if (opts.clientSecretCredentialPath) {
              body.client_secret_credential_path = resolveCredentialPath(
                opts.clientSecretCredentialPath,
              );
            }

            const r = await cliIpcCall<{ app: AppRow }>(
              "oauth_apps_upsert",
              { body },
            );

            if (!r.ok) {
              writeOutput(cmd, {
                ok: false,
                error: r.error ?? "Unknown error",
              });
              process.exitCode = 1;
              return;
            }

            const row = r.result?.app;
            if (row) {
              if (!shouldOutputJson(cmd)) {
                log.info(
                  `Upserted app: ${row.id} (provider: ${row.provider_key})`,
                );
              }
              writeOutput(cmd, formatAppRow(row));
            }
          },
        );

      // -----------------------------------------------------------------------
      // apps delete <id>
      // -----------------------------------------------------------------------

      apps
        .command("delete <id>")
        .description("Delete an OAuth app registration by ID")
        .addHelpText(
          "after",
          `
Arguments:
  id   The app UUID to delete (as returned by "apps list" or "apps get")

Permanently removes the app registration and its stored client secret from
the credential store. Any OAuth connections that reference this app will no longer be
able to refresh tokens.

Exits with code 1 if the app ID is not found.

Examples:
  $ assistant oauth apps delete 550e8400-e29b-41d4-a716-446655440000
  $ assistant oauth apps delete 550e8400-e29b-41d4-a716-446655440000 --json`,
        )
        .action(async (id: string, _opts: unknown, cmd: Command) => {
          const r = await cliIpcCall<{ ok: boolean }>(
            "oauth_apps_delete",
            { pathParams: { id } },
          );

          if (!r.ok) {
            if (r.statusCode === 404) {
              writeOutput(cmd, {
                ok: false,
                error: `App not found: ${id}. Run 'assistant oauth apps list' to see registered apps and their IDs.`,
              });
              process.exitCode = 1;
              return;
            }
            return exitFromIpcResult(r);
          }

          if (!shouldOutputJson(cmd)) {
            log.info(`Deleted app: ${id}`);
          }

          writeOutput(cmd, { ok: true, id });
        });
    },
  });
}
