import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { loadAllAssistants } from "../lib/assistant-config";
import { isProcessAlive, stopProcessByPidFile } from "../lib/process";
import { startLocalDaemon, startGateway } from "../lib/local";

export async function wake(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: assistant wake [options]");
    console.log("");
    console.log("Start the assistant and gateway processes.");
    console.log("");
    console.log("Options:");
    console.log(
      "  --watch    Run assistant and gateway in watch mode (hot reload on source changes)",
    );
    process.exit(0);
  }

  const watch = args.includes("--watch");

  const assistants = loadAllAssistants();
  const hasLocal = assistants.some((a) => a.cloud === "local");
  if (!hasLocal) {
    console.error(
      "Error: No local assistant found in lock file. Run 'assistant hatch local' first.",
    );
    process.exit(1);
  }

  const vellumDir = join(homedir(), ".vellum");
  const pidFile = join(vellumDir, "vellum.pid");
  const socketFile = join(vellumDir, "vellum.sock");

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
    await startLocalDaemon(watch);
  }

  // Start gateway (non-desktop only)
  if (!process.env.VELLUM_DESKTOP_APP) {
    const gatewayPidFile = join(vellumDir, "gateway.pid");
    const { alive, pid } = isProcessAlive(gatewayPidFile);
    if (alive) {
      if (watch) {
        // Restart in watch mode
        console.log(
          `Gateway running (pid ${pid}) — restarting in watch mode...`,
        );
        await stopProcessByPidFile(gatewayPidFile, "gateway");
        await startGateway(undefined, watch);
      } else {
        console.log(`Gateway already running (pid ${pid}).`);
      }
    } else {
      await startGateway(undefined, watch);
    }
  }

  console.log("✅ Wake complete.");
}
