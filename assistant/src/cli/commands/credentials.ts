import type { Command } from "commander";

import {
  deleteSecureKeyAsync,
  getSecureKey,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import {
  assertMetadataWritable,
  type CredentialMetadata,
  deleteCredentialMetadata,
  getCredentialMetadata,
  getCredentialMetadataById,
  listCredentialMetadata,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import { getCliLogger } from "../../util/logger.js";
import { shouldOutputJson, writeOutput } from "../utils.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Parse a `service:field` name string. Returns the parsed pair or undefined
 * if the format is invalid (no colon or empty segments).
 */
function parseCredentialName(
  name: string,
): { service: string; field: string } | undefined {
  const colonIndex = name.indexOf(":");
  if (colonIndex <= 0 || colonIndex >= name.length - 1) return undefined;
  return {
    service: name.slice(0, colonIndex),
    field: name.slice(colonIndex + 1),
  };
}

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
 * Build a structured credential output object suitable for both `inspect`
 * and `list` responses. Produces an identical shape for every credential.
 */
function buildCredentialOutput(
  metadata: CredentialMetadata,
  secret: string | undefined,
): Record<string, unknown> {
  return {
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
    accountInfo: metadata.accountInfo ?? null,
    grantedScopes: metadata.grantedScopes ?? null,
    expiresAt: metadata.expiresAt
      ? new Date(metadata.expiresAt).toISOString()
      : null,
    createdAt: new Date(metadata.createdAt).toISOString(),
    updatedAt: new Date(metadata.updatedAt).toISOString(),
    injectionTemplateCount: metadata.injectionTemplates?.length ?? 0,
  };
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
  if (output.accountInfo) log.info(`    Account:     ${output.accountInfo}`);
  if (output.grantedScopes)
    log.info(
      `    Scopes:      ${(output.grantedScopes as string[]).join(", ")}`,
    );
  if (output.expiresAt) log.info(`    Expires:     ${output.expiresAt}`);
  log.info(`    Created:     ${output.createdAt}`);
  log.info(`    Updated:     ${output.updatedAt}`);
  if ((output.injectionTemplateCount as number) > 0)
    log.info(`    Templates:   ${output.injectionTemplateCount}`);
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
Credentials are identified by name in service:field format, matching the
storage convention used internally (credential:{service}:{field}):

  twilio:account_sid        Twilio account SID
  twilio:auth_token         Twilio auth token
  telegram:bot_token        Telegram bot token
  slack_channel:bot_token   Slack channel bot token
  github:token              GitHub personal access token
  agentmail:api_key         AgentMail API key

Secrets are stored in AES-256-GCM encrypted storage. Metadata (policy,
timestamps, labels) is tracked separately and never contains secret values.

Examples:
  $ assistant credentials list
  $ assistant credentials list --search twilio
  $ assistant credentials set twilio:account_sid AC1234567890
  $ assistant credentials inspect twilio:account_sid
  $ assistant credentials delete twilio:auth_token`,
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
    .action((opts: { search?: string }, cmd: Command) => {
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

        const credentials = allMetadata.map((m) => {
          const secret = getSecureKey(`credential:${m.service}:${m.field}`);
          return buildCredentialOutput(m, secret);
        });

        writeOutput(cmd, { ok: true, credentials });

        if (!shouldOutputJson(cmd)) {
          if (credentials.length === 0) {
            log.info("No credentials found");
          } else {
            log.info(`${credentials.length} credential(s):\n`);
            for (const cred of credentials) {
              printCredentialHuman(cred);
              log.info("");
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
    .command("set <name> <value>")
    .description("Store a secret and create or update its metadata")
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
  name    Credential name in service:field format (e.g. twilio:account_sid)
  value   The secret value to store

If the credential already exists, the secret is overwritten and metadata is
updated with any provided flags. Omitted flags leave existing metadata intact.

Examples:
  $ assistant credentials set twilio:account_sid AC1234567890
  $ assistant credentials set fal:api_key key_live_abc --label "fal-prod" --description "Image generation"
  $ assistant credentials set github:token ghp_abc --allowed-tools "bash,host_bash"`,
    )
    .action(
      async (
        name: string,
        value: string,
        opts: { label?: string; description?: string; allowedTools?: string },
        cmd: Command,
      ) => {
        try {
          const parsed = parseCredentialName(name);
          if (!parsed) {
            writeOutput(cmd, {
              ok: false,
              error: `Invalid credential name "${name}". Expected service:field format (e.g. twilio:account_sid)`,
            });
            process.exitCode = 1;
            return;
          }

          const { service, field } = parsed;
          const storageKey = `credential:${service}:${field}`;

          assertMetadataWritable();

          const stored = await setSecureKeyAsync(storageKey, value);
          if (!stored) {
            writeOutput(cmd, {
              ok: false,
              error: `Failed to store secret for ${name}`,
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
    .command("delete <name>")
    .description("Remove a secret and its metadata from the vault")
    .addHelpText(
      "after",
      `
Arguments:
  name   Credential name in service:field format (e.g. twilio:account_sid)

Deletes both the encrypted secret and all associated metadata (policy,
timestamps, injection templates). This action cannot be undone.

Examples:
  $ assistant credentials delete twilio:auth_token
  $ assistant credentials delete github:token`,
    )
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      try {
        const parsed = parseCredentialName(name);
        if (!parsed) {
          writeOutput(cmd, {
            ok: false,
            error: `Invalid credential name "${name}". Expected service:field format (e.g. twilio:account_sid)`,
          });
          process.exitCode = 1;
          return;
        }

        const { service, field } = parsed;
        const storageKey = `credential:${service}:${field}`;

        assertMetadataWritable();

        const secretResult = await deleteSecureKeyAsync(storageKey);
        if (secretResult === "error") {
          writeOutput(cmd, {
            ok: false,
            error: "Failed to delete credential from secure storage",
          });
          process.exitCode = 1;
          return;
        }

        const metadataDeleted = deleteCredentialMetadata(service, field);

        if (secretResult !== "deleted" && !metadataDeleted) {
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
    .command("inspect <name>")
    .description("Show metadata and a masked preview of a stored credential")
    .addHelpText(
      "after",
      `
Arguments:
  name   Credential name in service:field format, or a credential UUID

Shows everything known about a credential without revealing the secret value.
The secret is masked to show only the last 4 characters (e.g. ****c123).

Displayed fields include: label, creation/update timestamps, allowed tools,
allowed domains, OAuth2 scopes, account info, and injection template count.

Examples:
  $ assistant credentials inspect twilio:account_sid
  $ assistant credentials inspect 7a3b1c2d-4e5f-6789-abcd-ef0123456789
  $ assistant credentials inspect --json slack_channel:bot_token`,
    )
    .action((name: string, _opts: unknown, cmd: Command) => {
      try {
        let metadata: CredentialMetadata | undefined;
        let storageKey: string;

        if (name.includes(":")) {
          const parsed = parseCredentialName(name);
          if (!parsed) {
            writeOutput(cmd, {
              ok: false,
              error: `Invalid credential name "${name}". Expected service:field format (e.g. twilio:account_sid)`,
            });
            process.exitCode = 1;
            return;
          }
          metadata = getCredentialMetadata(parsed.service, parsed.field);
          storageKey = `credential:${parsed.service}:${parsed.field}`;
        } else {
          metadata = getCredentialMetadataById(name);
          if (metadata) {
            storageKey = `credential:${metadata.service}:${metadata.field}`;
          } else {
            // No metadata found by UUID, and we can't determine the storage key
            writeOutput(cmd, { ok: false, error: "Credential not found" });
            process.exitCode = 1;
            return;
          }
        }

        const secret = getSecureKey(storageKey);

        if (!metadata && (secret == null || secret.length === 0)) {
          writeOutput(cmd, { ok: false, error: "Credential not found" });
          process.exitCode = 1;
          return;
        }

        // If we have a secret but no metadata, we still need metadata for the output.
        // This can happen if someone stored a key directly without going through the
        // credential set command. Build a minimal output in that case.
        if (!metadata) {
          // We only get here for the service:field path where we have storageKey
          // but no metadata record. Output what we can.
          const parsed = parseCredentialName(name)!;
          writeOutput(cmd, {
            ok: true,
            service: parsed.service,
            field: parsed.field,
            credentialId: null,
            scrubbedValue: scrubSecret(secret),
            hasSecret: secret != null && secret.length > 0,
            alias: null,
            usageDescription: null,
            allowedTools: [],
            allowedDomains: [],
            accountInfo: null,
            grantedScopes: null,
            expiresAt: null,
            createdAt: null,
            updatedAt: null,
            injectionTemplateCount: 0,
          });

          if (!shouldOutputJson(cmd)) {
            log.info(`  ${parsed.service}:${parsed.field}`);
            log.info(`    Value:       ${scrubSecret(secret)}`);
            log.info("    (no metadata record)");
          }
          return;
        }

        const output = buildCredentialOutput(metadata, secret);
        writeOutput(cmd, output);

        if (!shouldOutputJson(cmd)) {
          printCredentialHuman(output);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });

  // -------------------------------------------------------------------------
  // reveal
  // -------------------------------------------------------------------------

  credential
    .command("reveal <name>")
    .description("Print the plaintext value of a credential")
    .addHelpText(
      "after",
      `
Arguments:
  name   Credential name in service:field format, or a credential UUID

Prints the raw secret value to stdout for piping into other tools. In JSON
mode the value is returned as {"ok": true, "value": "..."}. In human mode
only the bare secret is printed (no labels or decoration) so it can be
captured with shell substitution, e.g. $(assistant credentials reveal twilio:auth_token).

Examples:
  $ assistant credentials reveal twilio:auth_token
  $ assistant credentials reveal 7a3b1c2d-4e5f-6789-abcd-ef0123456789
  $ assistant credentials reveal --json twilio:account_sid
  $ export TWILIO_TOKEN=$(assistant credentials reveal twilio:auth_token)`,
    )
    .action((name: string, _opts: unknown, cmd: Command) => {
      try {
        let storageKey: string;

        if (name.includes(":")) {
          const parsed = parseCredentialName(name);
          if (!parsed) {
            writeOutput(cmd, {
              ok: false,
              error: `Invalid credential name "${name}". Expected service:field format (e.g. twilio:account_sid)`,
            });
            process.exitCode = 1;
            return;
          }
          storageKey = `credential:${parsed.service}:${parsed.field}`;
        } else {
          const metadata = getCredentialMetadataById(name);
          if (metadata) {
            storageKey = `credential:${metadata.service}:${metadata.field}`;
          } else {
            writeOutput(cmd, { ok: false, error: "Credential not found" });
            process.exitCode = 1;
            return;
          }
        }

        const secret = getSecureKey(storageKey);

        if (secret == null || secret.length === 0) {
          writeOutput(cmd, { ok: false, error: "Credential not found" });
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
    });
}
