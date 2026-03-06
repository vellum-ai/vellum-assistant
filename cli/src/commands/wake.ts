import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  defaultLocalResources,
  resolveTargetAssistant,
} from "../lib/assistant-config.js";
import { isProcessAlive, stopProcessByPidFile } from "../lib/process";
import { startLocalDaemon, startGateway } from "../lib/local";

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
      "  --watch    Run assistant and gateway in watch mode (hot reload on source changes)",
    );
    process.exit(0);
  }

  const watch = args.includes("--watch");
  const nameArg = args.find((a) => !a.startsWith("-"));
  const entry = resolveTargetAssistant(nameArg);

  if (entry.cloud && entry.cloud !== "local") {
    console.error(
      `Error: 'vellum wake' only works with local assistants. '${entry.assistantId}' is a ${entry.cloud} instance.`,
    );
    process.exit(1);
  }

  const resources = entry.resources ?? defaultLocalResources();

  const pidFile = resources.pidFile;
  const socketFile = resources.socketPath;

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
          // Restart in watch mode
          console.log(
            `Assistant running (pid ${pid}) — restarting in watch mode...`,
          );
          await stopProcessByPidFile(pidFile, "assistant", [socketFile]);
          daemonRunning = false;
        } else {
          console.log(`Assistant already running (pid ${pid}).`);
        }
      } catch {
        // Process not alive, will start below
      }
    }
  }

  if (!daemonRunning) {
    await startLocalDaemon(watch, resources);
  }

  // Start gateway
  {
    const vellumDir = join(resources.instanceDir, ".vellum");
    const gatewayPidFile = join(vellumDir, "gateway.pid");
    const { alive, pid } = isProcessAlive(gatewayPidFile);
    if (alive) {
      if (watch) {
        // Restart in watch mode
        console.log(
          `Gateway running (pid ${pid}) — restarting in watch mode...`,
        );
        await stopProcessByPidFile(gatewayPidFile, "gateway");
        await startGateway(undefined, watch, resources);
      } else {
        console.log(`Gateway already running (pid ${pid}).`);
      }
    } else {
      await startGateway(undefined, watch, resources);
    }
  }

  console.log("Wake complete.");
}
