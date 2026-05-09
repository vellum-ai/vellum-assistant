/**
 * `assistant inference connections` CLI namespace.
 *
 * Subcommands:
 *   list    — list all connections (optionally filtered by provider)
 *   get     — show a single connection
 *   create  — create a new connection
 *   update  — update a connection's auth
 *   delete  — delete a connection (rejects if profiles reference it)
 */

import type { Command } from "commander";

import { getDb } from "../../memory/db-connection.js";
import { AuthSchema, VALID_CONNECTION_PROVIDERS } from "../../providers/inference/auth.js";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  updateConnection,
} from "../../providers/inference/connections.js";
import { log } from "../logger.js";
import { getConfig } from "../../config/loader.js";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatAuth(auth: ReturnType<typeof AuthSchema.parse>): string {
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
      const db = getDb();
      const rows = listConnections(db, opts.provider ? { provider: opts.provider } : undefined);

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
      const db = getDb();
      const conn = getConnection(db, name);

      if (!conn) {
        const msg = `Connection "${name}" not found.`;
        if (opts.json) {
          process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
        } else {
          log.error(msg);
        }
        process.exitCode = 1;
        return;
      }

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
// Subcommand: create
// ---------------------------------------------------------------------------

function attachCreateSubcommand(connections: Command): void {
  connections
    .command("create <name>")
    .description("Create a new provider connection")
    .requiredOption("--provider <p>", `Provider (${VALID_CONNECTION_PROVIDERS.join("|")})`)
    .requiredOption("--auth <type>", "Auth type: api_key|platform|none")
    .option("--credential <vault-key>", "Vault credential name (required for --auth api_key)")
    .option("--json", "Output as JSON")
    .action(
      async (
        name: string,
        opts: { provider: string; auth: string; credential?: string; json?: boolean },
      ) => {
        let authInput: unknown;
        if (opts.auth === "api_key") {
          if (!opts.credential) {
            const msg = "--credential is required when --auth api_key";
            if (opts.json) {
              process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
            } else {
              log.error(msg);
            }
            process.exitCode = 1;
            return;
          }
          authInput = { type: "api_key", credential: opts.credential };
        } else if (opts.auth === "platform") {
          if (opts.credential) {
            const msg = "--credential is not accepted with --auth platform";
            if (opts.json) {
              process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
            } else {
              log.error(msg);
            }
            process.exitCode = 1;
            return;
          }
          authInput = { type: "platform" };
        } else if (opts.auth === "none") {
          if (opts.credential) {
            const msg = "--credential is not accepted with --auth none";
            if (opts.json) {
              process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
            } else {
              log.error(msg);
            }
            process.exitCode = 1;
            return;
          }
          authInput = { type: "none" };
        } else {
          const msg = `Unknown auth type "${opts.auth}". Use: api_key, platform, none`;
          if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        const authResult = AuthSchema.safeParse(authInput);
        if (!authResult.success) {
          const msg = `Invalid auth: ${authResult.error.message}`;
          if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        const db = getDb();
        const result = createConnection(db, {
          name,
          provider: opts.provider,
          auth: authResult.data,
        });

        if (!result.ok) {
          let msg: string;
          if (result.error.code === "already_exists") {
            msg = `Connection "${name}" already exists. Use 'update' to modify it.`;
          } else if (result.error.code === "invalid_provider") {
            msg = `Invalid provider "${result.error.provider}". Valid: ${VALID_CONNECTION_PROVIDERS.join(", ")}`;
          } else {
            msg = "Invalid auth configuration.";
          }
          if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, connection: result.connection }) + "\n",
          );
        } else {
          process.stdout.write(
            `Created connection "${result.connection.name}" (provider=${result.connection.provider}, auth=${formatAuth(result.connection.auth)})\n`,
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
        let authInput: unknown;
        if (opts.auth === "api_key") {
          if (!opts.credential) {
            const msg = "--credential is required when --auth api_key";
            if (opts.json) {
              process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
            } else {
              log.error(msg);
            }
            process.exitCode = 1;
            return;
          }
          authInput = { type: "api_key", credential: opts.credential };
        } else if (opts.auth === "platform") {
          authInput = { type: "platform" };
        } else if (opts.auth === "none") {
          authInput = { type: "none" };
        } else {
          const msg = `Unknown auth type "${opts.auth}". Use: api_key, platform, none`;
          if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        const authResult = AuthSchema.safeParse(authInput);
        if (!authResult.success) {
          const msg = `Invalid auth: ${authResult.error.message}`;
          if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        const db = getDb();
        const result = updateConnection(db, name, { auth: authResult.data });

        if (!result.ok) {
          const msg =
            result.error.code === "not_found"
              ? `Connection "${name}" not found.`
              : "Invalid auth configuration.";
          if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, connection: result.connection }) + "\n",
          );
        } else {
          process.stdout.write(
            `Updated connection "${name}" auth to ${formatAuth(result.connection.auth)}\n`,
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
    .option("--force", "Delete even if profiles reference this connection")
    .option("--json", "Output as JSON")
    .action(async (name: string, opts: { force?: boolean; json?: boolean }) => {
      const db = getDb();

      // Find profiles referencing this connection.
      const config = getConfig();
      const profiles = config.llm?.profiles ?? {};
      const referencingProfiles = Object.entries(profiles)
        .filter(([, p]) => (p as Record<string, unknown>).provider_connection === name)
        .map(([profileName]) => profileName);

      const result = deleteConnection(db, name, {
        force: opts.force,
        referencingProfiles,
      });

      if (!result.ok) {
        let msg: string;
        if (result.error.code === "not_found") {
          msg = `Connection "${name}" not found.`;
        } else if (result.error.code === "has_references") {
          msg =
            `Connection "${name}" is referenced by ${result.error.count} profile(s): ` +
            `${referencingProfiles.join(", ")}. ` +
            "Use --force to delete anyway (profiles will error at next inference call).";
        } else {
          msg = "Delete failed.";
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
        } else {
          log.error(msg);
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true }) + "\n");
      } else {
        process.stdout.write(`Deleted connection "${name}"\n`);
        if (referencingProfiles.length > 0 && opts.force) {
          process.stdout.write(
            `Warning: ${referencingProfiles.length} profile(s) now reference a missing connection: ` +
              `${referencingProfiles.join(", ")}\n`,
          );
        }
      }
    });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function attachConnectionsSubcommand(inference: Command): void {
  const connections = inference
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
  ollama-local       → provider=ollama,    auth=none

Examples:
  $ assistant inference connections list
  $ assistant inference connections get anthropic-managed
  $ assistant inference connections create anthropic-personal \\
      --provider anthropic --auth api_key --credential credential/anthropic/api_key
  $ assistant inference connections update anthropic-personal --auth platform
  $ assistant inference connections delete anthropic-personal`,
  );

  attachListSubcommand(connections);
  attachGetSubcommand(connections);
  attachCreateSubcommand(connections);
  attachUpdateSubcommand(connections);
  attachDeleteSubcommand(connections);
}
