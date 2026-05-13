import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

interface AuthInfoResponse {
  platformUrl: string | null;
  assistantId: string | null;
  organizationId: string | null;
  userId: string | null;
  authenticated: boolean;
  message?: string;
}

export function registerAuthCommand(program: Command): void {
  registerCommand(program, {
    name: "auth",
    transport: "ipc",
    description: "Manage platform authentication and identity",
    build: (auth) => {
      auth.option("--json", "Machine-readable compact JSON output");

      auth.addHelpText(
        "after",
        `
The auth namespace manages the assistant's authentication state with the
Vellum platform. It provides commands to inspect identity and connection
status, helping diagnose configuration issues.

Examples:
  $ assistant auth info
  $ assistant auth info --json`,
      );

      // -----------------------------------------------------------------------
      // info
      // -----------------------------------------------------------------------

      auth
        .command("info")
        .description("Show platform identity and authentication status")
        .addHelpText(
          "after",
          `
Fields:
  platformUrl         The Vellum platform base URL this assistant connects to
  assistantId         This assistant's platform UUID
  organizationId      The organization this assistant belongs to (from PLATFORM_ORGANIZATION_ID)
  userId              The user who owns this assistant (from PLATFORM_USER_ID)
  authenticated       Whether all prerequisites for platform authentication are met
                      (platform URL and assistant API key both present)

When not authenticated, a message field provides guidance on next steps.

Examples:
  $ assistant auth info
  $ assistant auth info --json`,
        )
        .action(async (_opts: Record<string, unknown>, cmd: Command) => {
          const response =
            await cliIpcCall<AuthInfoResponse>("auth_info");

          if (!response.ok) {
            return exitFromIpcResult(response);
          }

          const result = response.result!;

          writeOutput(cmd, result);

          if (!shouldOutputJson(cmd)) {
            log.info(
              `Platform URL:        ${result.platformUrl ?? "(not set)"}`,
            );
            log.info(
              `Assistant ID:        ${result.assistantId ?? "(not set)"}`,
            );
            log.info(
              `Organization ID:     ${result.organizationId ?? "(not set)"}`,
            );
            log.info(`User ID:             ${result.userId ?? "(not set)"}`);
            log.info(
              `Authenticated:       ${result.authenticated ? "yes" : "no"}`,
            );
            if (!result.authenticated && result.message) {
              log.info("");
              log.info(result.message);
            }
          }
        });
    },
  });
}
