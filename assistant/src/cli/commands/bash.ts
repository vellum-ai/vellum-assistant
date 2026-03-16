import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { Command } from "commander";

import { getSignalsDir } from "../../util/platform.js";
import { log } from "../logger.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

interface BashSignalResult {
  requestId: string;
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
Sends a shell command to the running assistant for execution via the
signals directory. The assistant spawns the command in its own process environment
and returns stdout, stderr, and the exit code.

This is a developer debugging tool for inspecting how the assistant invokes and
observes shell commands. The command runs with the assistant's environment, working
directory, and process context — not the caller's shell.

Requires the assistant to be running with VELLUM_DEBUG=1. When debug mode is off
(the default), the assistant ignores bash signal files and returns an error.

The CLI writes the command to signals/bash.<requestId> and polls
signals/bash.<requestId>.result for the output. The assistant must be running
for this to work.

Arguments:
  command   The shell command string to execute (e.g. "echo hello", "ls -la").
            Runs in bash via \`bash -c\` in the assistant's process environment.

Examples:
  $ assistant bash "echo hello"
  $ assistant bash "which node"
  $ assistant bash "env | grep PATH" --timeout 10000
  $ assistant bash "ls -la"`,
    )
    .action((command: string, opts: { timeout: string }) => {
      const timeoutMs = parseInt(opts.timeout, 10);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
        log.error("Invalid timeout value. Must be a positive integer.");
        process.exitCode = 1;
        return;
      }

      const requestId = randomUUID();
      const signalsDir = getSignalsDir();

      try {
        mkdirSync(signalsDir, { recursive: true });
      } catch {
        log.error("Failed to create signals directory.");
        process.exitCode = 1;
        return;
      }

      // Write the command signal for the assistant to pick up.
      const signalPath = join(signalsDir, `bash.${requestId}`);
      const resultPath = join(signalsDir, `bash.${requestId}.result`);

      try {
        writeFileSync(
          signalPath,
          JSON.stringify({ requestId, command, timeoutMs }),
        );
      } catch {
        log.error("Failed to write bash signal file.");
        process.exitCode = 1;
        return;
      }

      log.info(`Sent command to assistant (requestId: ${requestId})`);
      log.info("Waiting for result...");

      // Poll for the result file until timeout.
      const deadline = Date.now() + timeoutMs + 5_000; // extra buffer for assistant overhead

      const poll = setInterval(() => {
        if (Date.now() > deadline) {
          clearInterval(poll);
          cleanupSignalFiles();
          log.error(
            "Timed out waiting for response. Is the assistant running?",
          );
          process.exitCode = 1;
          return;
        }

        if (!existsSync(resultPath)) return;

        let result: BashSignalResult;
        try {
          const content = readFileSync(resultPath, "utf-8");
          result = JSON.parse(content) as BashSignalResult;
        } catch {
          // File may be partially written; retry on next poll.
          return;
        }

        // Ignore stale results from a previous invocation.
        if (result.requestId !== requestId) return;

        clearInterval(poll);
        cleanupSignalFiles();

        if (result.error) {
          log.error(result.error);
          process.exitCode = 1;
          return;
        }

        if (result.stdout) {
          process.stdout.write(result.stdout);
          if (!result.stdout.endsWith("\n")) {
            process.stdout.write("\n");
          }
        }

        if (result.stderr) {
          process.stderr.write(result.stderr);
          if (!result.stderr.endsWith("\n")) {
            process.stderr.write("\n");
          }
        }

        if (result.timedOut) {
          log.info(`Command timed out in assistant.`);
        }

        if (result.exitCode != null && result.exitCode !== 0) {
          log.info(`Exit code: ${result.exitCode}`);
        }

        process.exitCode = result.exitCode ?? 1;
      }, POLL_INTERVAL_MS);

      function cleanupSignalFiles(): void {
        for (const p of [signalPath, resultPath]) {
          try {
            unlinkSync(p);
          } catch {
            // Best-effort cleanup; the file may already be gone.
          }
        }
      }
    });
}
