import { spawn } from "node:child_process";
import { join } from "node:path";

import type { Command } from "commander";

import { getDaemonStatus, stopDaemon } from "../daemon/lifecycle.js";
import { getCliLogger } from "../util/logger.js";

const log = getCliLogger("cli");

export function registerDevCommand(program: Command): void {
  program
    .command("dev")
    .description("Run the assistant in dev mode")
    .option(
      "--watch",
      "Auto-restart on source file changes (disruptive during Claude Code sessions)",
    )
    .addHelpText(
      "after",
      `
Starts the assistant in foreground dev mode for local development. If an
existing assistant is running, it is stopped first (waits up to 5 seconds
for an unresponsive assistant before force-killing it).

Behavioral notes:
  - Sets VELLUM_DEBUG=1 for DEBUG-level logging
  - Sets VELLUM_LOG_STDERR=1 so logs stream to stderr (visible in terminal)
  - Sets BASE_DATA_DIR to the repository root
  - The assistant runs in the foreground; press Ctrl+C to stop

The --watch flag passes bun --watch to the child process, which
auto-restarts the assistant whenever source files change. This is useful
during development but disruptive if a Claude Code session is active,
since the restart kills the running assistant mid-conversation.

Examples:
  $ vellum dev
  $ vellum dev --watch`,
    )
    .action(async (opts: { watch?: boolean }) => {
      let status = await getDaemonStatus();
      if (status.running) {
        log.info("Stopping existing assistant...");
        const stopResult = await stopDaemon();
        if (!stopResult.stopped && stopResult.reason === "stop_failed") {
          log.error(
            "Failed to stop existing assistant — process survived SIGKILL",
          );
          process.exit(1);
        }
      } else if (status.pid) {
        // PID file references a live process but the socket is unresponsive.
        // This can happen during the daemon startup window before the socket
        // is bound. Wait briefly for it to come up before replacing.
        log.info(
          "Assistant process alive but socket unresponsive — waiting for startup...",
        );
        const maxWait = 5000;
        const interval = 500;
        let waited = 0;
        let resolved = false;
        while (waited < maxWait) {
          await new Promise((r) => setTimeout(r, interval));
          waited += interval;
          status = await getDaemonStatus();
          if (status.running) {
            // Socket came up — stop the daemon normally.
            log.info("Assistant became responsive, stopping it...");
            const stopResult = await stopDaemon();
            if (!stopResult.stopped && stopResult.reason === "stop_failed") {
              log.error(
                "Failed to stop existing assistant — process survived SIGKILL",
              );
              process.exit(1);
            }
            resolved = true;
            break;
          }
          if (!status.pid) {
            // Process exited on its own — PID file already cleaned up.
            resolved = true;
            break;
          }
        }
        if (!resolved) {
          // Still alive but unresponsive after waiting — stop it via stopDaemon()
          // which handles SIGTERM → SIGKILL escalation and PID file cleanup.
          log.info("Assistant still unresponsive after wait — stopping it...");
          const stopResult = await stopDaemon();
          if (!stopResult.stopped && stopResult.reason === "stop_failed") {
            log.error(
              "Failed to stop existing assistant — process survived SIGKILL",
            );
            process.exit(1);
          }
        }
      }

      const mainPath = `${import.meta.dirname}/../daemon/main.ts`;

      const useWatch = opts.watch === true;
      log.info(
        `Starting assistant in dev mode${
          useWatch ? " with file watching" : ""
        } (Ctrl+C to stop)`,
      );

      const repoRoot = join(import.meta.dirname, "..", "..", "..");
      const args = useWatch ? ["--watch", "run", mainPath] : ["run", mainPath];
      const child = spawn("bun", args, {
        stdio: "inherit",
        env: {
          ...process.env,
          BASE_DATA_DIR: repoRoot,
          VELLUM_LOG_STDERR: "1",
          VELLUM_DEBUG: "1",
        },
      });

      const forward = (signal: NodeJS.Signals) => {
        child.kill(signal);
      };
      process.on("SIGINT", () => forward("SIGINT"));
      process.on("SIGTERM", () => forward("SIGTERM"));

      child.on("exit", (code) => {
        process.exit(code ?? 0);
      });
    });
}
