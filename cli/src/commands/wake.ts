import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  defaultLocalResources,
  resolveTargetAssistant,
} from "../lib/assistant-config.js";
import { isProcessAlive } from "../lib/process";
import {
  startLocalDaemon,
  startGateway,
  startOutboundProxy,
} from "../lib/local";

export async function wake(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum wake [<name>]");
    console.log("");
    console.log("Start the assistant and gateway processes.");
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name>    Name of the assistant to start (default: active or only local)",
    );
    process.exit(0);
  }

  const nameArg = args.find((a) => !a.startsWith("-"));
  const entry = resolveTargetAssistant(nameArg);
  const resources = entry.resources ?? defaultLocalResources();

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
        console.log(`Assistant already running (pid ${pid}).`);
      } catch {
        // Process not alive, will start below
      }
    }
  }

  if (!daemonRunning) {
    await startLocalDaemon(false, resources);
  }

  // Start gateway (non-desktop only)
  if (!process.env.VELLUM_DESKTOP_APP) {
    const vellumDir = join(resources.instanceDir, ".vellum");
    const gatewayPidFile = join(vellumDir, "gateway.pid");
    const { alive, pid } = isProcessAlive(gatewayPidFile);
    if (alive) {
      console.log(`Gateway already running (pid ${pid}).`);
    } else {
      await startGateway(undefined, false, resources);
    }
  }

  // Start outbound proxy
  await startOutboundProxy(false, resources);

  console.log("Wake complete.");
}
