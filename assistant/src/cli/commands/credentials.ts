import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import type { CredentialPromptResult } from "../../runtime/routes/credential-prompt-routes.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { tryResolveConversationId } from "../utils/conversation-id.js";

// ---------------------------------------------------------------------------
// Format-aware error output
// ---------------------------------------------------------------------------

function writeError(cmd: Command, message: string): void {
  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: false, error: message });
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
}

// ---------------------------------------------------------------------------
// CES shell lockdown guard
// ---------------------------------------------------------------------------

function isUntrustedShell(): boolean {
  return process.env.VELLUM_UNTRUSTED_SHELL === "1";
}

const UNTRUSTED_SHELL_ERROR =
  "This command is not available in untrusted shell mode. " +
  "Raw secret access is restricted when running under CES shell lockdown.";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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
// Response types for IPC calls
// ---------------------------------------------------------------------------

interface CredentialsListResponse {
  credentials: Record<string, unknown>[];
  managedCredentials: Record<string, unknown>[];
}

interface CredentialsStatusResponse {
  backend: string;
  storePath?: string;
  storeExists?: boolean;
  storeKeyPath?: string;
  storeKeyExists?: boolean;
  ready?: boolean;
  url?: string;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerCredentialsCommand(program: Command): void {
  registerCommand(program, {
    name: "credentials",
    transport: "ipc",
    description:
      "Manage credentials in the encrypted vault (API keys, tokens, passwords)",
    build: (credential) => {
      credential.option("--json", "Machine-readable compact JSON output");

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

      // -----------------------------------------------------------------------
      // list
      // -----------------------------------------------------------------------

      credential
        .command("list")
        .description(
          "List all stored credentials with metadata and masked values",
        )
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
          const r = await cliIpcCall<CredentialsListResponse>(
            "credentials_list",
            { body: { search: opts.search } },
          );
          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          }

          const { credentials, managedCredentials } = r.result!;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, {
              ok: true,
              credentials,
              managedCredentials,
            });
          } else {
            const totalCount = credentials.length + managedCredentials.length;
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
              if (managedCredentials.length > 0) {
                log.info(
                  `${managedCredentials.length} platform-managed credential(s):\n`,
                );
                for (const managed of managedCredentials) {
                  printManagedCredentialHuman(managed);
                  log.info("");
                }
              }
            }
          }
        });

      // -----------------------------------------------------------------------
      // status
      // -----------------------------------------------------------------------

      credential
        .command("status")
        .description("Show the active credential backend and its configuration")
        .addHelpText(
          "after",
          `
Shows which credential storage backend this process is using and backend-specific
path or connection details. Run this to diagnose credential lookup mismatches —
for example, when the CLI and the daemon are reading from different stores.

Backend types:
  encrypted-store   Direct file read from keys.enc (standalone CLI, no daemon)
  ces-rpc           Delegates to the running CES process via stdio RPC (daemon)
  ces-http          Delegates to CES sidecar over HTTP (containerized/Docker mode)

Also shows the CREDENTIAL_SECURITY_DIR, GATEWAY_SECURITY_DIR, and
VELLUM_WORKSPACE_DIR env vars so you can confirm which instance directory this
process is scoped to.

Examples:
  $ assistant credentials status
  $ assistant credentials status --json`,
        )
        .action(async (_opts: Record<string, unknown>, cmd: Command) => {
          const r =
            await cliIpcCall<CredentialsStatusResponse>("credentials_status");
          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          }

          const info = r.result!;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, ...info });
          } else {
            log.info(`Backend: ${info.backend}`);
            if (info.backend === "encrypted-store") {
              log.info(
                `  Store path:  ${info.storePath} [${info.storeExists ? "exists" : "missing"}]`,
              );
              log.info(
                `  Key path:    ${info.storeKeyPath} [${info.storeKeyExists ? "exists" : "missing"}]`,
              );
            } else if (info.backend === "ces-rpc") {
              log.info(`  RPC ready:   ${info.ready}`);
            } else if (info.backend === "ces-http") {
              log.info(`  URL:         ${info.url}`);
            }
          }
        });

      // -----------------------------------------------------------------------
      // set
      // -----------------------------------------------------------------------

      credential
        .command("set <value>")
        .description("Store a secret and create or update its metadata")
        .requiredOption(
          "--service <service>",
          "Service namespace (e.g. google)",
        )
        .requiredOption("--field <field>", "Field name (e.g. client_secret)")
        .option("--label <label>", 'Human-friendly label (e.g. "prod", "work")')
        .option(
          "--description <description>",
          "What this credential is used for",
        )
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
            const allowedTools = opts.allowedTools
              ? opts.allowedTools.split(",").map((t) => t.trim())
              : undefined;

            const r = await cliIpcCall<{
              credentialId: string;
              service: string;
              field: string;
            }>("credentials_set", {
              body: {
                service: opts.service,
                field: opts.field,
                value,
                label: opts.label,
                description: opts.description,
                allowedTools,
              },
            });

            if (!r.ok) {
              writeError(
                cmd,
                r.error ??
                  `Failed to store credential ${opts.service}:${opts.field}`,
              );
              process.exitCode = 1;
              return;
            }

            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, {
                ok: true,
                credentialId: r.result!.credentialId,
                service: opts.service,
                field: opts.field,
              });
            } else {
              log.info(
                `Stored credential ${opts.service}:${opts.field} (${r.result!.credentialId})`,
              );
            }
          },
        );

      // -----------------------------------------------------------------------
      // delete
      // -----------------------------------------------------------------------

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
        .action(
          async (opts: { service: string; field: string }, cmd: Command) => {
            const r = await cliIpcCall<{
              service: string;
              field: string;
            }>("credentials_delete", {
              body: { service: opts.service, field: opts.field },
            });

            if (!r.ok) {
              writeError(
                cmd,
                r.error ??
                  `Failed to delete credential ${opts.service}:${opts.field}`,
              );
              process.exitCode = 1;
              return;
            }

            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, {
                ok: true,
                service: opts.service,
                field: opts.field,
              });
            } else {
              log.info(`Deleted credential ${opts.service}:${opts.field}`);
            }
          },
        );

      // -----------------------------------------------------------------------
      // inspect
      // -----------------------------------------------------------------------

      credential
        .command("inspect [id]")
        .description(
          "Show metadata and a masked preview of a stored credential",
        )
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
            if (!opts.service && !opts.field && !id) {
              writeError(
                cmd,
                "Either --service and --field flags or a credential UUID is required",
              );
              process.exitCode = 1;
              return;
            }

            const r = await cliIpcCall<Record<string, unknown>>(
              "credentials_inspect",
              {
                body: {
                  service: opts.service,
                  field: opts.field,
                  id,
                },
              },
            );

            if (!r.ok) {
              writeError(cmd, r.error ?? "Credential not found");
              process.exitCode = 1;
              return;
            }

            const output = r.result!;

            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, { ok: true, ...output });
            } else {
              printCredentialHuman(output);
              if (output.brokerUnreachable) {
                log.info(
                  "    ⚠ Credential store is unreachable — ensure the assistant is running",
                );
              }
            }
          },
        );

      // -----------------------------------------------------------------------
      // reveal
      // -----------------------------------------------------------------------

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
            // CES shell lockdown: deny raw secret reveal in untrusted shells.
            if (isUntrustedShell()) {
              writeError(cmd, UNTRUSTED_SHELL_ERROR);
              process.exitCode = 1;
              return;
            }

            if (!opts.service && !opts.field && !id) {
              writeError(
                cmd,
                "Either --service and --field flags or a credential UUID is required",
              );
              process.exitCode = 1;
              return;
            }

            const r = await cliIpcCall<{ value: string }>(
              "credentials_reveal",
              {
                body: {
                  service: opts.service,
                  field: opts.field,
                  id,
                },
              },
            );

            if (!r.ok) {
              writeError(cmd, r.error ?? "Credential not found");
              process.exitCode = 1;
              return;
            }

            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, { ok: true, value: r.result!.value });
            } else {
              process.stdout.write(r.result!.value + "\n");
            }
          },
        );

      // -----------------------------------------------------------------------
      // prompt
      // -----------------------------------------------------------------------

      credential
        .command("prompt")
        .description(
          "Securely prompt the user for a credential via the app UI and store it",
        )
        .requiredOption(
          "--service <service>",
          "Service namespace (e.g. sentry)",
        )
        .requiredOption("--field <field>", "Field name (e.g. auth_token)")
        .requiredOption("--label <label>", "Display label for the prompt UI")
        .option("--description <description>", "Context shown in the prompt UI")
        .option("--placeholder <placeholder>", "Placeholder text for the input")
        .option(
          "--usage-description <description>",
          "Human-readable description of intended usage, stored in credential metadata and shown as the prompt's purpose",
        )
        .option(
          "--allowed-domains <domains>",
          "Comma-separated domains where this credential may be used",
        )
        .option(
          "--allowed-tools <tools>",
          "Comma-separated tool names that may use this credential",
        )
        .option(
          "--injection-templates <json>",
          "JSON array of injection template objects",
        )
        .addHelpText(
          "after",
          `
Opens a secure credential input prompt in the user's connected app (desktop,
web, etc.). The user enters the secret through the UI — it never passes through
the conversation or CLI output. On success the credential is stored in the
encrypted vault with the specified metadata.

Requires the assistant to be running with at least one connected client.

Examples:
  $ assistant credentials prompt --service sentry --field auth_token \\
      --label "Sentry Auth Token" --placeholder "sntrys_..." \\
      --usage-description "Read Sentry issues and events" \\
      --allowed-domains "sentry.io" \\
      --injection-templates '[{"hostPattern":"sentry.io","injectionType":"header","headerName":"Authorization","valuePrefix":"Bearer "}]'`,
        )
        .action(
          async (
            opts: {
              service: string;
              field: string;
              label: string;
              description?: string;
              placeholder?: string;
              usageDescription?: string;
              allowedDomains?: string;
              allowedTools?: string;
              injectionTemplates?: string;
            },
            cmd: Command,
          ) => {
            const allowedDomains = opts.allowedDomains
              ? opts.allowedDomains.split(",").map((d) => d.trim())
              : undefined;
            const allowedTools = opts.allowedTools
              ? opts.allowedTools.split(",").map((t) => t.trim())
              : undefined;

            let injectionTemplates: unknown[] | undefined;
            if (opts.injectionTemplates) {
              try {
                injectionTemplates = JSON.parse(opts.injectionTemplates);
                if (!Array.isArray(injectionTemplates)) {
                  writeError(cmd, "--injection-templates must be a JSON array");
                  process.exitCode = 1;
                  return;
                }
              } catch {
                writeError(cmd, "--injection-templates must be valid JSON");
                process.exitCode = 1;
                return;
              }
            }

            const PROMPT_TIMEOUT_MS = 310_000; // 5 min + 10s buffer
            const ipc = await cliIpcCall<CredentialPromptResult>(
              "credentials_prompt",
              {
                body: {
                  service: opts.service,
                  field: opts.field,
                  label: opts.label,
                  description: opts.description,
                  placeholder: opts.placeholder,
                  usageDescription: opts.usageDescription,
                  allowedDomains,
                  allowedTools,
                  injectionTemplates,
                  conversationId: tryResolveConversationId(),
                },
              },
              { timeoutMs: PROMPT_TIMEOUT_MS },
            );

            if (!ipc.ok) {
              writeError(
                cmd,
                ipc.error ?? "Failed to connect to the assistant",
              );
              process.exitCode = 1;
              return;
            }

            if (!ipc.result?.ok) {
              // An explicit user cancel is a valid outcome, not a failure.
              // Surface it as an informational message and exit 130 — the
              // conventional "user interrupt" (SIGINT) code — so callers and
              // setup skills can tell a deliberate cancel apart from a genuine
              // error (which stays exit 1). Nothing was stored either way.
              if (ipc.result?.cancelled) {
                if (shouldOutputJson(cmd)) {
                  writeOutput(cmd, ipc.result);
                } else {
                  log.info(
                    ipc.result.error ??
                      "Credential prompt cancelled by the user",
                  );
                }
                process.exitCode = 130;
                return;
              }
              writeError(cmd, ipc.result?.error ?? "Credential prompt failed");
              process.exitCode = 1;
              return;
            }

            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, ipc.result);
            } else {
              log.info(
                ipc.result.message ??
                  `Stored credential ${opts.service}:${opts.field}`,
              );
            }
          },
        );
    },
  });
}
