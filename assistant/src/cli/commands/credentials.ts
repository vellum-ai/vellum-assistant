import type { Command } from "commander";

import {
  fetchManagedCatalog,
  type ManagedCredentialDescriptor,
} from "../../credential-execution/managed-catalog.js";
import { syncManualTokenConnection } from "../../oauth/manual-token-connection.js";
import {
  disconnectOAuthProvider,
  getConnectionByProvider,
  listConnections,
  type OAuthConnectionRow,
} from "../../oauth/oauth-store.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  assertMetadataWritable,
  type CredentialMetadata,
  deleteCredentialMetadata,
  getCredentialMetadata,
  getCredentialMetadataById,
  listCredentialMetadata,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import {
  deleteSecureKeyViaDaemon,
  getSecureKeyResultViaDaemon,
  getSecureKeyViaDaemon,
  setSecureKeyViaDaemon,
} from "../lib/daemon-credential-client.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

// ---------------------------------------------------------------------------
// CES shell lockdown guard
// ---------------------------------------------------------------------------

/**
 * Returns true when the current process is running inside an untrusted shell
 * (CES shell lockdown active). CLI commands that reveal raw secrets must
 * check this and fail deterministically.
 */
function isUntrustedShell(): boolean {
  return process.env.VELLUM_UNTRUSTED_SHELL === "1";
}

/** Error message for commands blocked by CES shell lockdown. */
const UNTRUSTED_SHELL_ERROR =
  "This command is not available in untrusted shell mode. " +
  "Raw secret access is restricted when running under CES shell lockdown.";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Scrub a secret value for display. Shows `****` + last 4 characters for
 * secrets longer than 4 chars, `****` for secrets 4 chars or fewer, and
 * `(not set)` when no secret is stored.
 */
function scrubSecret(secret: string | undefined): string {
  if (secret == null || secret.length === 0) return "(not set)";
  if (secret.length <= 4) return "****";
  return "****" + secret.slice(-4);
}

/**
 * Safely look up an OAuth connection for a credential service.
 * Returns undefined when the oauth-store has no data or the tables
 * haven't been created yet (pre-migration).
 */
function safeGetConnectionByProvider(
  service: string,
): OAuthConnectionRow | undefined {
  try {
    return getConnectionByProvider(service);
  } catch {
    return undefined;
  }
}

/**
 * Safely list all OAuth connections. Returns an empty array when the
 * oauth-store has no data or the tables haven't been created yet.
 */
function safeListConnections(): OAuthConnectionRow[] {
  try {
    return listConnections();
  } catch {
    return [];
  }
}

/**
 * Build a structured credential output object suitable for both `inspect`
 * and `list` responses. Produces an identical shape for every credential.
 * Optionally enriches with data from the oauth-store when a matching
 * connection exists.
 */
function buildCredentialOutput(
  metadata: CredentialMetadata,
  secret: string | undefined,
  connection?: OAuthConnectionRow,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    ok: true,
    service: metadata.service,
    field: metadata.field,
    credentialId: metadata.credentialId,
    scrubbedValue: scrubSecret(secret),
    hasSecret: secret != null && secret.length > 0,
    alias: metadata.alias ?? null,
    usageDescription: metadata.usageDescription ?? null,
    allowedTools: metadata.allowedTools,
    allowedDomains: metadata.allowedDomains,
    createdAt: new Date(metadata.createdAt).toISOString(),
    updatedAt: new Date(metadata.updatedAt).toISOString(),
    injectionTemplateCount: metadata.injectionTemplates?.length ?? 0,
    grantedScopes: connection ? JSON.parse(connection.grantedScopes) : null,
    expiresAt: connection?.expiresAt
      ? new Date(connection.expiresAt).toISOString()
      : null,
  };

  if (connection) {
    output.oauthConnectionId = connection.id;
    output.oauthAccountInfo = connection.accountInfo ?? null;
    output.oauthStatus = connection.status;
    output.oauthHasRefreshToken = connection.hasRefreshToken === 1;
    output.oauthLabel = connection.label ?? null;
  }

  return output;
}

/**
 * Print a human-readable view of a single credential to the logger.
 */
function printCredentialHuman(output: Record<string, unknown>): void {
  log.info(`  ${output.service}:${output.field}`);
  log.info(`    ID:          ${output.credentialId}`);
  log.info(`    Value:       ${output.scrubbedValue}`);
  if (output.alias) log.info(`    Label:       ${output.alias}`);
  if (output.usageDescription)
    log.info(`    Description: ${output.usageDescription}`);
  if (
    Array.isArray(output.allowedTools) &&
    (output.allowedTools as string[]).length > 0
  )
    log.info(
      `    Tools:       ${(output.allowedTools as string[]).join(", ")}`,
    );
  if (
    Array.isArray(output.allowedDomains) &&
    (output.allowedDomains as string[]).length > 0
  )
    log.info(
      `    Domains:     ${(output.allowedDomains as string[]).join(", ")}`,
    );
  log.info(`    Created:     ${output.createdAt}`);
  log.info(`    Updated:     ${output.updatedAt}`);
  if ((output.injectionTemplateCount as number) > 0)
    log.info(`    Templates:   ${output.injectionTemplateCount}`);

  // OAuth connection enrichment
  if (output.oauthStatus) {
    log.info(`    OAuth:       ${output.oauthStatus}`);
    if (output.oauthAccountInfo)
      log.info(`    Account:     ${output.oauthAccountInfo}`);
    if (output.oauthLabel) log.info(`    OAuth Label: ${output.oauthLabel}`);
    log.info(`    Refresh:     ${output.oauthHasRefreshToken ? "yes" : "no"}`);
  }
}

/**
 * Build a structured output object for a platform-managed credential descriptor.
 * Never includes token values — only handle references and non-secret metadata.
 */
function buildManagedCredentialOutput(
  descriptor: ManagedCredentialDescriptor,
): Record<string, unknown> {
  return {
    ok: true,
    source: "platform",
    handle: descriptor.handle,
    provider: descriptor.provider,
    connectionId: descriptor.connectionId,
    accountInfo: descriptor.accountInfo,
    grantedScopes: descriptor.grantedScopes,
    status: descriptor.status,
  };
}

/**
 * Print a human-readable view of a platform-managed credential to the logger.
 */
function printManagedCredentialHuman(output: Record<string, unknown>): void {
  log.info(`  [platform-managed] ${output.provider}`);
  log.info(`    Handle:      ${output.handle}`);
  log.info(`    Status:      ${output.status}`);
  if (output.accountInfo) log.info(`    Account:     ${output.accountInfo}`);
  if (
    Array.isArray(output.grantedScopes) &&
    (output.grantedScopes as string[]).length > 0
  )
    log.info(
      `    Scopes:      ${(output.grantedScopes as string[]).join(", ")}`,
    );
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerCredentialsCommand(program: Command): void {
  const credential = program
    .command("credentials")
    .description(
      "Manage credentials in the encrypted vault (API keys, tokens, passwords)",
    )
    .option("--json", "Machine-readable compact JSON output");

  credential.addHelpText(
    "after",
    `
Credentials are identified by --service and --field flags, matching the
storage convention used internally (credential/{service}/{field}):

  --service twilio --field account_sid        Twilio account SID
  --service twilio --field auth_token         Twilio auth token
  --service telegram --field bot_token        Telegram bot token
  --service slack_channel --field bot_token   Slack channel bot token
  --service github --field token              GitHub personal access token
  --service agentmail --field api_key         AgentMail API key

Secrets are stored in AES-256-GCM encrypted storage. Metadata (policy,
timestamps, labels) is tracked separately and never contains secret values.

Examples:
  $ assistant credentials list
  $ assistant credentials list --search twilio
  $ assistant credentials set --service twilio --field account_sid AC1234567890
  $ assistant credentials inspect --service twilio --field account_sid
  $ assistant credentials reveal --service twilio --field account_sid
  $ assistant credentials delete --service twilio --field auth_token`,
  );

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  credential
    .command("list")
    .description("List all stored credentials with metadata and masked values")
    .option(
      "--search <query>",
      "Filter credentials by substring match on service, field, label, or description",
    )
    .addHelpText(
      "after",
      `
Lists all credentials in the vault. Each entry includes the same fields as
"inspect" — scrubbed value, timestamps, policy, and metadata.

The --search flag filters results by case-insensitive substring match against
the credential's service name, field name, label, or description. For example, --search
twilio matches twilio:account_sid, twilio:auth_token, and twilio:phone_number.

Returns an array of credential objects. Empty array if no credentials exist
or none match the search query.

Examples:
  $ assistant credentials list
  $ assistant credentials list --search twilio
  $ assistant credentials list --search bot_token
  $ assistant credentials list --json`,
    )
    .action(async (opts: { search?: string }, cmd: Command) => {
      try {
        let allMetadata = listCredentialMetadata();

        if (opts.search) {
          const query = opts.search.toLowerCase();
          allMetadata = allMetadata.filter((m) => {
            const service = m.service.toLowerCase();
            const field = m.field.toLowerCase();
            const alias = (m.alias ?? "").toLowerCase();
            const description = (m.usageDescription ?? "").toLowerCase();
            return (
              service.includes(query) ||
              field.includes(query) ||
              alias.includes(query) ||
              description.includes(query)
            );
          });
        }

        // Build a lookup of oauth connections keyed by providerKey for enrichment.
        // listConnections() returns rows in no guaranteed order, so we compare
        // createdAt to keep the most recent active connection per provider —
        // matching the behaviour of getConnectionByProvider() used by inspect.
        const allConnections = safeListConnections();
        const connectionsByProvider = new Map<string, OAuthConnectionRow>();
        for (const conn of allConnections) {
          if (conn.status !== "active") continue;
          const existing = connectionsByProvider.get(conn.providerKey);
          if (!existing || conn.createdAt > existing.createdAt) {
            connectionsByProvider.set(conn.providerKey, conn);
          }
        }

        const credentials = await Promise.all(
          allMetadata.map(async (m) => {
            const secret = await getSecureKeyViaDaemon(
              credentialKey(m.service, m.field),
            );
            const connection = connectionsByProvider.get(m.service);
            return buildCredentialOutput(m, secret, connection);
          }),
        );

        // Fetch platform-managed credentials (best-effort — errors do not
        // break local listing). Filter by search query if provided.
        const managedResult = await fetchManagedCatalog();
        let managedOutputs: Record<string, unknown>[] = [];
        if (managedResult.ok && managedResult.descriptors.length > 0) {
          let descriptors = managedResult.descriptors;
          if (opts.search) {
            const query = opts.search.toLowerCase();
            descriptors = descriptors.filter(
              (d) =>
                d.provider.toLowerCase().includes(query) ||
                d.handle.toLowerCase().includes(query) ||
                (d.accountInfo ?? "").toLowerCase().includes(query),
            );
          }
          managedOutputs = descriptors.map(buildManagedCredentialOutput);
        }

        writeOutput(cmd, {
          ok: true,
          credentials,
          managedCredentials: managedOutputs,
        });

        if (!shouldOutputJson(cmd)) {
          const totalCount = credentials.length + managedOutputs.length;
          if (totalCount === 0) {
            log.info("No credentials found");
          } else {
            if (credentials.length > 0) {
              log.info(`${credentials.length} local credential(s):\n`);
              for (const cred of credentials) {
                printCredentialHuman(cred);
                log.info("");
              }
            }
            if (managedOutputs.length > 0) {
              log.info(
                `${managedOutputs.length} platform-managed credential(s):\n`,
              );
              for (const managed of managedOutputs) {
                printManagedCredentialHuman(managed);
                log.info("");
              }
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });

  // -------------------------------------------------------------------------
  // set
  // -------------------------------------------------------------------------

  credential
    .command("set <value>")
    .description("Store a secret and create or update its metadata")
    .requiredOption(
      "--service <service>",
      "Service namespace (e.g. integration:google)",
    )
    .requiredOption("--field <field>", "Field name (e.g. client_secret)")
    .option("--label <label>", 'Human-friendly label (e.g. "prod", "work")')
    .option("--description <description>", "What this credential is used for")
    .option(
      "--allowed-tools <tools>",
      "Comma-separated tool names that may use this credential",
    )
    .addHelpText(
      "after",
      `
Arguments:
  value   The secret value to store

If the credential already exists, the secret is overwritten and metadata is
updated with any provided flags. Omitted flags leave existing metadata intact.

Examples:
  $ assistant credentials set --service twilio --field account_sid AC1234567890
  $ assistant credentials set --service fal --field api_key key_live_abc --label "fal-prod" --description "Image generation"
  $ assistant credentials set --service github --field token ghp_abc --allowed-tools "bash,host_bash"`,
    )
    .action(
      async (
        value: string,
        opts: {
          service: string;
          field: string;
          label?: string;
          description?: string;
          allowedTools?: string;
        },
        cmd: Command,
      ) => {
        try {
          const { service, field } = opts;

          assertMetadataWritable();

          const stored = await setSecureKeyViaDaemon(
            "credential",
            `${service}:${field}`,
            value,
          );
          if (!stored) {
            writeOutput(cmd, {
              ok: false,
              error: `Failed to store secret for ${service}:${field}`,
            });
            process.exitCode = 1;
            return;
          }

          const allowedTools = opts.allowedTools
            ? opts.allowedTools.split(",").map((t) => t.trim())
            : undefined;

          const metadata = upsertCredentialMetadata(service, field, {
            alias: opts.label,
            usageDescription: opts.description,
            allowedTools,
          });
          await syncManualTokenConnection(service);

          writeOutput(cmd, {
            ok: true,
            credentialId: metadata.credentialId,
            service,
            field,
          });

          if (!shouldOutputJson(cmd)) {
            log.info(
              `Stored credential ${service}:${field} (${metadata.credentialId})`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  credential
    .command("delete")
    .description("Remove a secret and its metadata from the vault")
    .requiredOption("--service <service>", "Service namespace")
    .requiredOption("--field <field>", "Field name")
    .addHelpText(
      "after",
      `
Deletes both the encrypted secret and all associated metadata (policy,
timestamps, injection templates). This action cannot be undone.

Examples:
  $ assistant credentials delete --service twilio --field auth_token
  $ assistant credentials delete --service github --field token`,
    )
    .action(async (opts: { service: string; field: string }, cmd: Command) => {
      try {
        const { service, field } = opts;

        assertMetadataWritable();

        const secretResult = await deleteSecureKeyViaDaemon(
          "credential",
          `${service}:${field}`,
        );
        if (secretResult === "error") {
          writeOutput(cmd, {
            ok: false,
            error: "Failed to delete credential from secure storage",
          });
          process.exitCode = 1;
          return;
        }

        const metadataDeleted = deleteCredentialMetadata(service, field);

        // Also clean up the OAuth connection and new-format secure keys.
        // disconnectOAuthProvider is a no-op when no connection exists.
        let oauthResult: "disconnected" | "not-found" | "error" = "not-found";
        try {
          oauthResult = await disconnectOAuthProvider(service);
        } catch {
          // Best-effort — OAuth tables may not exist yet
        }

        if (oauthResult === "error") {
          writeOutput(cmd, {
            ok: false,
            error: "Failed to disconnect OAuth provider — please try again",
          });
          process.exitCode = 1;
          return;
        }

        if (
          secretResult !== "deleted" &&
          !metadataDeleted &&
          oauthResult !== "disconnected"
        ) {
          writeOutput(cmd, { ok: false, error: "Credential not found" });
          process.exitCode = 1;
          return;
        }

        writeOutput(cmd, { ok: true, service, field });

        if (!shouldOutputJson(cmd)) {
          log.info(`Deleted credential ${service}:${field}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });

  // -------------------------------------------------------------------------
  // inspect
  // -------------------------------------------------------------------------

  credential
    .command("inspect [id]")
    .description("Show metadata and a masked preview of a stored credential")
    .option("--service <service>", "Service namespace")
    .option("--field <field>", "Field name")
    .addHelpText(
      "after",
      `
Arguments:
  id   (optional) Credential UUID for lookup by ID

Shows everything known about a credential without revealing the secret value.
The secret is masked to show only the last 4 characters (e.g. ****c123).

Displayed fields include: label, creation/update timestamps, allowed tools,
allowed domains, OAuth2 scopes, account info, and injection template count.

Use --service and --field to look up by service/field, or pass a UUID as a
positional argument. One of the two forms is required.

Examples:
  $ assistant credentials inspect --service twilio --field account_sid
  $ assistant credentials inspect 7a3b1c2d-4e5f-6789-abcd-ef0123456789
  $ assistant credentials inspect --json --service slack_channel --field bot_token`,
    )
    .action(
      async (
        id: string | undefined,
        opts: { service?: string; field?: string },
        cmd: Command,
      ) => {
        try {
          let metadata: CredentialMetadata | undefined;
          let storageKey: string;
          let service: string | undefined;
          let field: string | undefined;

          if (opts.service && opts.field) {
            service = opts.service;
            field = opts.field;
            metadata = getCredentialMetadata(service, field);
            storageKey = credentialKey(service, field);
          } else if (id) {
            metadata = getCredentialMetadataById(id);
            if (metadata) {
              storageKey = credentialKey(metadata.service, metadata.field);
              service = metadata.service;
              field = metadata.field;
            } else {
              // No metadata found by UUID, and we can't determine the storage key
              writeOutput(cmd, { ok: false, error: "Credential not found" });
              process.exitCode = 1;
              return;
            }
          } else {
            writeOutput(cmd, {
              ok: false,
              error:
                "Either --service and --field flags or a credential UUID is required",
            });
            process.exitCode = 1;
            return;
          }

          const { value: secret, unreachable } =
            await getSecureKeyResultViaDaemon(storageKey);

          if (!metadata && (secret == null || secret.length === 0)) {
            if (unreachable) {
              writeOutput(cmd, {
                ok: false,
                error:
                  "Keychain broker is unreachable — restart the Vellum app and accept the macOS Keychain prompt",
              });
            } else {
              writeOutput(cmd, { ok: false, error: "Credential not found" });
            }
            process.exitCode = 1;
            return;
          }

          // If we have a secret but no metadata, we still need metadata for the output.
          // This can happen if someone stored a key directly without going through the
          // credential set command. Build a minimal output in that case.
          if (!metadata) {
            writeOutput(cmd, {
              ok: true,
              service: service,
              field: field,
              credentialId: null,
              scrubbedValue: scrubSecret(secret),
              hasSecret: secret != null && secret.length > 0,
              alias: null,
              usageDescription: null,
              allowedTools: [],
              allowedDomains: [],
              createdAt: null,
              updatedAt: null,
              injectionTemplateCount: 0,
            });

            if (!shouldOutputJson(cmd)) {
              log.info(`  ${service}:${field}`);
              log.info(`    Value:       ${scrubSecret(secret)}`);
              log.info("    (no metadata record)");
            }
            return;
          }

          const connection = safeGetConnectionByProvider(metadata.service);
          const output = buildCredentialOutput(metadata, secret, connection);

          if (unreachable && (secret == null || secret.length === 0)) {
            output.scrubbedValue = "(broker unreachable)";
            output.brokerUnreachable = true;
          }

          writeOutput(cmd, output);

          if (!shouldOutputJson(cmd)) {
            printCredentialHuman(output);
            if (unreachable && (secret == null || secret.length === 0)) {
              log.info(
                "    \u26A0 Keychain broker unreachable — restart the Vellum app and accept the macOS Keychain prompt to access credentials",
              );
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );

  // -------------------------------------------------------------------------
  // reveal
  // -------------------------------------------------------------------------

  credential
    .command("reveal [id]")
    .description("Print the plaintext value of a credential")
    .option("--service <service>", "Service namespace")
    .option("--field <field>", "Field name")
    .addHelpText(
      "after",
      `
Arguments:
  id   (optional) Credential UUID for lookup by ID

Prints the raw secret value to stdout for piping into other tools. In JSON
mode the value is returned as {"ok": true, "value": "..."}. In human mode
only the bare secret is printed (no labels or decoration) so it can be
captured with shell substitution.

Use --service and --field to look up by service/field, or pass a UUID as a
positional argument. One of the two forms is required.

Examples:
  $ assistant credentials reveal --service twilio --field auth_token
  $ assistant credentials reveal 7a3b1c2d-4e5f-6789-abcd-ef0123456789
  $ assistant credentials reveal --json --service twilio --field account_sid
  $ export TWILIO_TOKEN=$(assistant credentials reveal --service twilio --field auth_token)`,
    )
    .action(
      async (
        id: string | undefined,
        opts: { service?: string; field?: string },
        cmd: Command,
      ) => {
        try {
          // CES shell lockdown: deny raw secret reveal in untrusted shells.
          if (isUntrustedShell()) {
            writeOutput(cmd, { ok: false, error: UNTRUSTED_SHELL_ERROR });
            process.exitCode = 1;
            return;
          }

          let storageKey: string;

          if (opts.service && opts.field) {
            storageKey = credentialKey(opts.service, opts.field);
          } else if (id) {
            const metadata = getCredentialMetadataById(id);
            if (metadata) {
              storageKey = credentialKey(metadata.service, metadata.field);
            } else {
              writeOutput(cmd, { ok: false, error: "Credential not found" });
              process.exitCode = 1;
              return;
            }
          } else {
            writeOutput(cmd, {
              ok: false,
              error:
                "Either --service and --field flags or a credential UUID is required",
            });
            process.exitCode = 1;
            return;
          }

          const { value: secret, unreachable } =
            await getSecureKeyResultViaDaemon(storageKey);

          if (secret == null || secret.length === 0) {
            if (unreachable) {
              writeOutput(cmd, {
                ok: false,
                error:
                  "Keychain broker is unreachable — restart the Vellum app and accept the macOS Keychain prompt",
              });
            } else {
              writeOutput(cmd, { ok: false, error: "Credential not found" });
            }
            process.exitCode = 1;
            return;
          }

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, value: secret });
          } else {
            process.stdout.write(secret + "\n");
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );
}
