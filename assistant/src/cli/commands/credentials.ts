import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import type { CredentialPromptResult } from "../../runtime/routes/credential-prompt-routes.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { tryResolveConversationId } from "../utils/conversation-id.js";
import { credentialsHelp } from "./credentials.help.js";

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
// Shared helpers
// ---------------------------------------------------------------------------

function printCredentialHuman(output: Record<string, unknown>): void {
  log.info(`  ${output.service}:${output.field}`);
  log.info(`    ID:          ${output.credentialId}`);
  log.info(`    Value:       ${output.scrubbedValue}`);
  if (output.alias) {
    log.info(`    Label:       ${output.alias}`);
  }
  if (output.usageDescription) {
    log.info(`    Description: ${output.usageDescription}`);
  }
  if (
    Array.isArray(output.allowedTools) &&
    (output.allowedTools as string[]).length > 0
  ) {
    log.info(
      `    Tools:       ${(output.allowedTools as string[]).join(", ")}`,
    );
  }
  if (
    Array.isArray(output.allowedDomains) &&
    (output.allowedDomains as string[]).length > 0
  ) {
    log.info(
      `    Domains:     ${(output.allowedDomains as string[]).join(", ")}`,
    );
  }
  log.info(`    Created:     ${output.createdAt}`);
  log.info(`    Updated:     ${output.updatedAt}`);
  if ((output.injectionTemplateCount as number) > 0) {
    log.info(`    Templates:   ${output.injectionTemplateCount}`);
  }

  // OAuth connection enrichment
  if (output.oauthStatus) {
    log.info(`    OAuth:       ${output.oauthStatus}`);
    if (output.oauthAccountInfo) {
      log.info(`    Account:     ${output.oauthAccountInfo}`);
    }
    if (output.oauthLabel) {
      log.info(`    OAuth Label: ${output.oauthLabel}`);
    }
    log.info(`    Refresh:     ${output.oauthHasRefreshToken ? "yes" : "no"}`);
  }
}

function printManagedCredentialHuman(output: Record<string, unknown>): void {
  log.info(`  [platform-managed] ${output.provider}`);
  log.info(`    Handle:      ${output.handle}`);
  log.info(`    Status:      ${output.status}`);
  if (output.accountInfo) {
    log.info(`    Account:     ${output.accountInfo}`);
  }
  if (
    Array.isArray(output.grantedScopes) &&
    (output.grantedScopes as string[]).length > 0
  ) {
    log.info(
      `    Scopes:      ${(output.grantedScopes as string[]).join(", ")}`,
    );
  }
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
    name: credentialsHelp.name,
    transport: "ipc",
    description: credentialsHelp.description,
    build: (credential) => {
      applyCommandHelp(credential, credentialsHelp);

      // -----------------------------------------------------------------------
      // list
      // -----------------------------------------------------------------------

      subcommand(credential, "list").action(
        async (opts: { search?: string }, cmd: Command) => {
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
        },
      );

      // -----------------------------------------------------------------------
      // status
      // -----------------------------------------------------------------------

      subcommand(credential, "status").action(
        async (_opts: Record<string, unknown>, cmd: Command) => {
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
        },
      );

      // -----------------------------------------------------------------------
      // set
      // -----------------------------------------------------------------------

      subcommand(credential, "set").action(
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
      // grant
      // -----------------------------------------------------------------------

      subcommand(credential, "grant").action(
        async (
          opts: { service: string; field: string; tool: string },
          cmd: Command,
        ) => {
          const r = await cliIpcCall<{
            service: string;
            field: string;
            allowedTools: string[];
          }>("credentials_grant", {
            body: {
              service: opts.service,
              field: opts.field,
              tool: opts.tool,
            },
          });

          if (!r.ok) {
            writeError(
              cmd,
              r.error ??
                `Failed to grant ${opts.tool} access to ${opts.service}:${opts.field}`,
            );
            process.exitCode = 1;
            return;
          }

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, {
              ok: true,
              service: opts.service,
              field: opts.field,
              allowedTools: r.result!.allowedTools,
            });
          } else {
            log.info(
              `Granted ${opts.tool} read access to ${opts.service}:${opts.field}`,
            );
          }
        },
      );

      // -----------------------------------------------------------------------
      // delete
      // -----------------------------------------------------------------------

      subcommand(credential, "delete").action(
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

      subcommand(credential, "inspect").action(
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

      subcommand(credential, "reveal").action(
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

          const r = await cliIpcCall<{ value: string }>("credentials_reveal", {
            body: {
              service: opts.service,
              field: opts.field,
              id,
            },
          });

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

      subcommand(credential, "prompt").action(
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
            writeError(cmd, ipc.error ?? "Failed to connect to the assistant");
            process.exitCode = 1;
            return;
          }

          if (!ipc.result?.ok) {
            // A pending one-time collection link is not success (nothing is
            // stored yet) and not an error. Exit 75 (EX_TEMPFAIL) so setup
            // skills that chain on exit 0 = stored do not proceed with a
            // missing credential, while the message hands the model the
            // link to relay in-channel.
            if (ipc.result?.pending) {
              if (shouldOutputJson(cmd)) {
                writeOutput(cmd, ipc.result);
              } else {
                log.info(
                  ipc.result.message ??
                    "A one-time credential link was generated — the value is not stored yet",
                );
              }
              process.exitCode = 75;
              return;
            }
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
                  ipc.result.error ?? "Credential prompt cancelled by the user",
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
