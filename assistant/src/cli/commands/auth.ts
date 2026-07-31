import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { authHelp } from "./auth.help.js";

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
    name: authHelp.name,
    transport: "ipc",
    description: authHelp.description,
    build: (auth) => {
      applyCommandHelp(auth, authHelp);

      subcommand(auth, "info").action(
        async (_opts: Record<string, unknown>, cmd: Command) => {
          const response = await cliIpcCall<AuthInfoResponse>("auth_info");

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
        },
      );
    },
  });
}
