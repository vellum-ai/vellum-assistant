import { homedir } from "os";
import { join } from "path";

import { stopProcessByPidFile } from "../lib/process";

export async function sleep(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: assistant sleep");
    console.log("");
    console.log("Stop the assistant and gateway processes.");
    process.exit(0);
  }

  const vellumDir = join(homedir(), ".vellum");
  const daemonPidFile = join(vellumDir, "vellum.pid");
  const socketFile = join(vellumDir, "vellum.sock");
  const gatewayPidFile = join(vellumDir, "gateway.pid");

  // Stop daemon
  const daemonStopped = await stopProcessByPidFile(daemonPidFile, "daemon", [
    socketFile,
  ]);
  if (!daemonStopped) {
    console.log("Assistant is not running.");
  } else {
    console.log("Assistant stopped.");
  }

  // Stop gateway — use a longer timeout because the gateway has a configurable
  // drain window (GATEWAY_SHUTDOWN_DRAIN_MS, default 5s) before it exits.
  const gatewayStopped = await stopProcessByPidFile(
    gatewayPidFile,
    "gateway",
    undefined,
    7000,
  );
  if (!gatewayStopped) {
    console.log("Gateway is not running.");
  } else {
    console.log("Gateway stopped.");
  }
}
