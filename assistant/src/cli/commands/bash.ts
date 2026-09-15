/**
 * `assistant bash` runs a shell command with the same sanitized environment
 * the bash tool forwards to tool-call subprocesses.
 */

import type { Command } from "commander";

import { applyCommandHelp, commandSpec } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { bashHelp } from "./bash.help.js";

export function registerBashCommand(program: Command): void {
  registerCommand(program, {
    name: commandSpec(bashHelp),
    transport: "local",
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

        const { runSanitizedBash } = await import(
          "../../tools/terminal/sanitized-bash.js"
        );
        const data = await runSanitizedBash(command, timeoutMs);

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
          log.info("Command timed out.");
        }

        if (data.exitCode != null && data.exitCode !== 0) {
          log.info(`Exit code: ${data.exitCode}`);
        }

        process.exitCode = data.exitCode ?? 1;
      });
    },
  });
}
