import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";

const DEFAULT_TIMEOUT_MS = 30_000;

interface DebugBashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

export function registerBashCommand(program: Command): void {
  program
    .command("bash <command>")
    .description(
      "Execute a shell command through the assistant process for debugging",
    )
    .option(
      "-t, --timeout <ms>",
      "Timeout in milliseconds for command execution",
      String(DEFAULT_TIMEOUT_MS),
    )
    .addHelpText(
      "after",
      `
Sends a shell command to the running assistant for execution via the IPC
socket. The assistant spawns the command in its own process environment and
returns stdout, stderr, and the exit code.

This is a developer debugging tool for inspecting how the assistant invokes and
observes shell commands. The command runs with the assistant's environment, working
directory, and process context — not the caller's shell.

Requires the assistant to be running with VELLUM_DEBUG=1. When debug mode is off
(the default), the assistant returns an error immediately.

Arguments:
  command   The shell command string to execute (e.g. "echo hello", "ls -la").
            Runs in bash via \`bash -c\` in the assistant's process environment.

Examples:
  $ assistant bash "echo hello"
  $ assistant bash "which node"
  $ assistant bash "env | grep PATH" --timeout 10000
  $ assistant bash "ls -la"`,
    )
    .action(async (command: string, opts: { timeout: string }) => {
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
}
