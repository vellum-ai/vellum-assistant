/**
 * `assistant bash` — run a shell command in the assistant's process
 * environment (debug tool, requires VELLUM_DEBUG=1 on the daemon).
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { applyCommandHelp, commandSpec } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { bashHelp } from "./bash.help.js";

interface DebugBashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

export function registerBashCommand(program: Command): void {
  registerCommand(program, {
    name: commandSpec(bashHelp),
    transport: "ipc",
    description: bashHelp.description,
    build: (cmd) => {
      applyCommandHelp(cmd, bashHelp);
      cmd.action(async (command: string, opts: { timeout: string }) => {
        const timeoutMs = parseInt(opts.timeout, 10);
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
          log.error("Invalid timeout value. Must be a positive integer.");
          process.exitCode = 1;
          return;
        }

        const result = await cliIpcCall<DebugBashResult>(
          "debug_bash",
          { body: { command, timeoutMs } },
          { timeoutMs: timeoutMs + 10_000 },
        );

        if (!result.ok) {
          log.error(result.error ?? "Failed to reach the assistant.");
          process.exitCode = 1;
          return;
        }

        const data = result.result!;

        if (data.error) {
          log.error(data.error);
          process.exitCode = 1;
          return;
        }

        if (data.stdout) {
          process.stdout.write(data.stdout);
          if (!data.stdout.endsWith("\n")) {
            process.stdout.write("\n");
          }
        }

        if (data.stderr) {
          process.stderr.write(data.stderr);
          if (!data.stderr.endsWith("\n")) {
            process.stderr.write("\n");
          }
        }

        if (data.timedOut) {
          log.info(`Command timed out in assistant.`);
        }

        if (data.exitCode != null && data.exitCode !== 0) {
          log.info(`Exit code: ${data.exitCode}`);
        }

        process.exitCode = data.exitCode ?? 1;
      });
    },
  });
}
