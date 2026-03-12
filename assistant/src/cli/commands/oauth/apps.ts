import type { Command } from "commander";

import {
  deleteApp,
  getApp,
  getAppByProviderAndClientId,
  getMostRecentAppByProvider,
  listApps,
  upsertApp,
} from "../../../oauth/oauth-store.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

/** Format an app row for output, converting timestamps to ISO strings. */
function formatAppRow(row: {
  id: string;
  providerKey: string;
  clientId: string;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    id: row.id,
    providerKey: row.providerKey,
    clientId: row.clientId,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export function registerAppCommands(oauth: Command): void {
  const apps = oauth
    .command("apps")
    .description("Manage OAuth app registrations (client IDs and secrets)");

  apps.addHelpText(
    "after",
    `
Apps represent OAuth client registrations — a client_id and optional
client_secret linked to a provider. Each provider can have multiple apps
(e.g. different client IDs for different environments).

Examples:
  $ assistant oauth apps list
  $ assistant oauth apps get --id <uuid>
  $ assistant oauth apps get --provider integration:gmail
  $ assistant oauth apps upsert --provider integration:gmail --client-id abc123
  $ assistant oauth apps delete <id>`,
  );

  // ---------------------------------------------------------------------------
  // apps list
  // ---------------------------------------------------------------------------

  apps
    .command("list")
    .description("List all OAuth app registrations")
    .addHelpText(
      "after",
      `
Returns all registered OAuth apps with their provider key, client ID, and
timestamps. Output is an array of app objects.

In JSON mode (--json), returns the array directly. In human mode, logs a
summary count and prints the formatted list.

Examples:
  $ assistant oauth apps list
  $ assistant oauth apps list --json`,
    )
    .action((_opts: unknown, cmd: Command) => {
      try {
        const rows = listApps().map(formatAppRow);

        if (!shouldOutputJson(cmd)) {
          log.info(`Found ${rows.length} app(s)`);
        }

        writeOutput(cmd, rows);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // apps get
  // ---------------------------------------------------------------------------

  apps
    .command("get")
    .description(
      "Look up an OAuth app by ID, provider + client-id, or provider",
    )
    .option("--id <id>", "App ID (UUID)")
    .option("--provider <key>", "Provider key (e.g. integration:gmail)")
    .option("--client-id <id>", "OAuth client ID (requires --provider)")
    .addHelpText(
      "after",
      `
Three lookup modes are supported:

  1. By app ID:
     $ assistant oauth apps get --id <uuid>

  2. By provider + client ID (exact match):
     $ assistant oauth apps get --provider integration:gmail --client-id abc123

  3. By provider only (returns the most recently created app):
     $ assistant oauth apps get --provider integration:gmail

At least --id or --provider must be specified.`,
    )
    .action(
      (
        opts: { id?: string; provider?: string; clientId?: string },
        cmd: Command,
      ) => {
        try {
          let row;

          if (opts.id) {
            row = getApp(opts.id);
          } else if (opts.provider && opts.clientId) {
            row = getAppByProviderAndClientId(opts.provider, opts.clientId);
          } else if (opts.provider) {
            row = getMostRecentAppByProvider(opts.provider);
          } else {
            writeOutput(cmd, {
              ok: false,
              error: "Provide --id, --provider, or --provider + --client-id",
            });
            process.exitCode = 1;
            return;
          }

          if (!row) {
            writeOutput(cmd, { ok: false, error: "App not found" });
            process.exitCode = 1;
            return;
          }

          writeOutput(cmd, formatAppRow(row));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );

  // ---------------------------------------------------------------------------
  // apps upsert
  // ---------------------------------------------------------------------------

  apps
    .command("upsert")
    .description("Create or return an existing OAuth app registration")
    .requiredOption("--provider <key>", "Provider key (e.g. integration:gmail)")
    .requiredOption("--client-id <id>", "OAuth client ID")
    .option(
      "--client-secret <secret>",
      "OAuth client secret (stored in secure keychain)",
    )
    .addHelpText(
      "after",
      `
Creates a new app registration or returns the existing one if an app with the
same provider and client ID already exists. The client secret, if provided, is
stored in the secure system keychain — not in the database.

When an existing app is matched and a --client-secret is provided, the stored
secret is updated. The app row itself is returned as-is.

Examples:
  $ assistant oauth apps upsert --provider integration:gmail --client-id abc123
  $ assistant oauth apps upsert --provider integration:slack --client-id def456 --client-secret s3cret
  $ assistant oauth apps upsert --provider integration:gmail --client-id abc123 --json`,
    )
    .action(
      async (
        opts: { provider: string; clientId: string; clientSecret?: string },
        cmd: Command,
      ) => {
        try {
          const row = await upsertApp(
            opts.provider,
            opts.clientId,
            opts.clientSecret,
          );

          if (!shouldOutputJson(cmd)) {
            log.info(`Upserted app: ${row.id} (provider: ${row.providerKey})`);
          }

          writeOutput(cmd, formatAppRow(row));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );

  // ---------------------------------------------------------------------------
  // apps delete <id>
  // ---------------------------------------------------------------------------

  apps
    .command("delete <id>")
    .description("Delete an OAuth app registration by ID")
    .addHelpText(
      "after",
      `
Arguments:
  id   The app UUID to delete (as returned by "apps list" or "apps get")

Permanently removes the app registration and its stored client secret from
the keychain. Any OAuth connections that reference this app will no longer be
able to refresh tokens.

Exits with code 1 if the app ID is not found.

Examples:
  $ assistant oauth apps delete 550e8400-e29b-41d4-a716-446655440000
  $ assistant oauth apps delete 550e8400-e29b-41d4-a716-446655440000 --json`,
    )
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      try {
        const deleted = await deleteApp(id);

        if (!deleted) {
          writeOutput(cmd, {
            ok: false,
            error: `App not found: ${id}`,
          });
          process.exitCode = 1;
          return;
        }

        if (!shouldOutputJson(cmd)) {
          log.info(`Deleted app: ${id}`);
        }

        writeOutput(cmd, { ok: true, id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });
}
