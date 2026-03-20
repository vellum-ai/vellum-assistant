import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { resolveTargetAssistant } from "../lib/assistant-config.js";
import { dockerResourceNames, wakeContainers } from "../lib/docker.js";
import { isProcessAlive, stopProcessByPidFile } from "../lib/process";
import {
  isAssistantWatchModeAvailable,
  isGatewayWatchModeAvailable,
  startLocalDaemon,
  startGateway,
} from "../lib/local";
import { maybeStartNgrokTunnel } from "../lib/ngrok";

export async function wake(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum wake [<name>] [options]");
    console.log("");
    console.log("Start the assistant and gateway processes.");
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name>    Name of the assistant to start (default: active or only local)",
    );
    console.log("");
    console.log("Options:");
    console.log(
      "  --watch        Run assistant and gateway in watch mode (hot reload on source changes)",
    );
    console.log(
      "  --foreground   Run assistant in foreground with logs printed to terminal",
    );
    process.exit(0);
  }

  const watch = args.includes("--watch");
  const foreground = args.includes("--foreground");
  const nameArg = args.find((a) => !a.startsWith("-"));
  const entry = resolveTargetAssistant(nameArg);

  if (entry.cloud === "docker") {
    if (watch || foreground) {
      const ignored = [watch && "--watch", foreground && "--foreground"]
        .filter(Boolean)
        .join(" and ");
      console.warn(
        `Warning: ${ignored} ignored for Docker instances (not supported).`,
      );
    }
    const res = dockerResourceNames(entry.assistantId);
    await wakeContainers(res);
    console.log("Docker containers started.");
    console.log("Wake complete.");
    return;
  }

  if (entry.cloud && entry.cloud !== "local") {
    console.error(
      `Error: 'vellum wake' only works with local and docker assistants. '${entry.assistantId}' is a ${entry.cloud} instance.`,
    );
    process.exit(1);
  }

  if (!entry.resources) {
    console.error(
      `Error: Local assistant '${entry.assistantId}' is missing resource configuration. Re-hatch to fix.`,
    );
    process.exit(1);
  }
  const resources = entry.resources;

  const pidFile = resources.pidFile;

  // Check if daemon is already running
  let daemonRunning = false;
  if (existsSync(pidFile)) {
    const pidStr = readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0);
        daemonRunning = true;
        if (watch) {
          // Restart in watch mode — but only if source files are available.
          // Watch mode requires bun --watch with .ts sources; packaged desktop
          // builds only have a compiled binary. Stopping the daemon without a
          // viable watch-mode path would leave the user with no running assistant.
          if (!isAssistantWatchModeAvailable()) {
            console.log(
              `Assistant running (pid ${pid}) — watch mode not available (no source files). Keeping existing process.`,
            );
          } else {
            console.log(
              `Assistant running (pid ${pid}) — restarting in watch mode...`,
            );
            await stopProcessByPidFile(pidFile, "assistant");
            daemonRunning = false;
          }
        } else {
          console.log(`Assistant already running (pid ${pid}).`);
        }
      } catch {
        // Process not alive, will start below
      }
    }
  }

  if (!daemonRunning) {
    await startLocalDaemon(watch, resources, { foreground });
  }

  // Start gateway
  {
    const vellumDir = join(resources.instanceDir, ".vellum");
    const gatewayPidFile = join(vellumDir, "gateway.pid");
    const { alive, pid } = isProcessAlive(gatewayPidFile);
    if (alive) {
      if (watch) {
        // Guard gateway restart separately: check gateway source availability.
        if (!isGatewayWatchModeAvailable()) {
          console.log(
            `Gateway running (pid ${pid}) — watch mode not available (no source files). Keeping existing process.`,
          );
        } else {
          console.log(
            `Gateway running (pid ${pid}) — restarting in watch mode...`,
          );
          await stopProcessByPidFile(gatewayPidFile, "gateway");
          await startGateway(watch, resources);
        }
      } else {
        console.log(`Gateway already running (pid ${pid}).`);
      }
    } else {
      await startGateway(watch, resources);
    }
  }

  // Auto-start ngrok if webhook integrations (e.g. Telegram) are configured.
  // Set BASE_DATA_DIR so ngrok reads the correct instance config.
  const prevBaseDataDir = process.env.BASE_DATA_DIR;
  process.env.BASE_DATA_DIR = resources.instanceDir;
  const ngrokChild = await maybeStartNgrokTunnel(resources.gatewayPort);
  if (ngrokChild?.pid) {
    const ngrokPidFile = join(resources.instanceDir, ".vellum", "ngrok.pid");
    writeFileSync(ngrokPidFile, String(ngrokChild.pid));
  }
  if (prevBaseDataDir !== undefined) {
    process.env.BASE_DATA_DIR = prevBaseDataDir;
  } else {
    delete process.env.BASE_DATA_DIR;
  }

  console.log("Wake complete.");

  if (foreground) {
    console.log("Running in foreground (Ctrl+C to stop)...\n");
    // Block forever — the daemon is running with inherited stdio so its
    // output streams to this terminal. When the user hits Ctrl+C, SIGINT
    // propagates to the daemon child and both exit.
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        console.log("\nShutting down...");
        resolve();
      });
      process.on("SIGTERM", () => resolve());
    });
  }
}
