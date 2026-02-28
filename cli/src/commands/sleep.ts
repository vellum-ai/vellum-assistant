import { homedir } from "os";
import { join } from "path";

import { loadAllAssistants } from "../lib/assistant-config";
import { stopProcessByPidFile } from "../lib/process";

export async function sleep(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum sleep");
    console.log("");
    console.log("Stop the daemon and gateway processes.");
    process.exit(0);
  }

  const assistants = loadAllAssistants();
  const hasLocal = assistants.some((a) => a.cloud === "local");
  if (!hasLocal) {
    console.error("Error: No local assistant found in lock file. Run 'vellum hatch local' first.");
    process.exit(1);
  }

  const vellumDir = join(homedir(), ".vellum");
  const daemonPidFile = join(vellumDir, "vellum.pid");
  const socketFile = join(vellumDir, "vellum.sock");
  const gatewayPidFile = join(vellumDir, "gateway.pid");

  // Stop daemon
  const daemonStopped = await stopProcessByPidFile(daemonPidFile, "daemon", [socketFile]);
  if (!daemonStopped) {
    console.log("Daemon is not running.");
  } else {
    console.log("Daemon stopped.");
  }

  // Stop gateway
  const gatewayStopped = await stopProcessByPidFile(gatewayPidFile, "gateway");
  if (!gatewayStopped) {
    console.log("Gateway is not running.");
  } else {
    console.log("Gateway stopped.");
  }
}
