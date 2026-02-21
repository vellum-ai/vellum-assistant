import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { loadAllAssistants } from "../lib/assistant-config";
import { isProcessAlive } from "../lib/process";
import { startLocalDaemon, startGateway } from "./hatch";

export async function wake(): Promise<void> {
  const assistants = loadAllAssistants();
  const hasLocal = assistants.some((a) => a.cloud === "local");
  if (!hasLocal) {
    console.error("Error: No local assistant found in lock file. Run 'vellum hatch local' first.");
    process.exit(1);
  }

  const vellumDir = join(homedir(), ".vellum");
  const pidFile = join(vellumDir, "vellum.pid");

  // Check if daemon is already running
  let daemonRunning = false;
  if (existsSync(pidFile)) {
    const pidStr = readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0);
        daemonRunning = true;
        console.log(`Daemon already running (pid ${pid}).`);
      } catch {
        // Process not alive, will start below
      }
    }
  }

  if (!daemonRunning) {
    await startLocalDaemon();
  }

  // Start gateway (non-desktop only)
  if (!process.env.VELLUM_DESKTOP_APP) {
    const gatewayPidFile = join(vellumDir, "gateway.pid");
    const { alive, pid } = isProcessAlive(gatewayPidFile);
    if (alive) {
      console.log(`Gateway already running (pid ${pid}).`);
    } else {
      await startGateway();
    }
  }

  console.log("✅ Wake complete.");
}
