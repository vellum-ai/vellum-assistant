import { spawn } from "node:child_process";
import { join } from "node:path";

import type { Command } from "commander";

import { getDaemonStatus, stopDaemon } from "../daemon/lifecycle.js";
import { getCliLogger } from "../util/logger.js";

const log = getCliLogger("cli");

export function registerDevCommand(program: Command): void {
  program
    .command("dev")
    .description("Run the daemon in dev mode")
    .option(
      "--watch",
      "Auto-restart on source file changes (disruptive during Claude Code sessions)",
    )
    .action(async (opts: { watch?: boolean }) => {
      let status = await getDaemonStatus();
      if (status.running) {
        log.info("Stopping existing daemon...");
        const stopResult = await stopDaemon();
        if (!stopResult.stopped && stopResult.reason === "stop_failed") {
          log.error(
            "Failed to stop existing daemon — process survived SIGKILL",
          );
          process.exit(1);
        }
      } else if (status.pid) {
        // PID file references a live process but the socket is unresponsive.
        // This can happen during the daemon startup window before the socket
        // is bound. Wait briefly for it to come up before replacing.
        log.info(
          "Daemon process alive but socket unresponsive — waiting for startup...",
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
            log.info("Daemon became responsive, stopping it...");
            const stopResult = await stopDaemon();
            if (!stopResult.stopped && stopResult.reason === "stop_failed") {
              log.error(
                "Failed to stop existing daemon — process survived SIGKILL",
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
          log.info("Daemon still unresponsive after wait — stopping it...");
          const stopResult = await stopDaemon();
          if (!stopResult.stopped && stopResult.reason === "stop_failed") {
            log.error(
              "Failed to stop existing daemon — process survived SIGKILL",
            );
            process.exit(1);
          }
        }
      }

      const mainPath = `${import.meta.dirname}/../daemon/main.ts`;

      const useWatch = opts.watch === true;
      log.info(
        `Starting daemon in dev mode${
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
