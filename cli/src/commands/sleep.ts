import { join } from "path";

import {
  defaultLocalResources,
  resolveTargetAssistant,
} from "../lib/assistant-config.js";
import { stopProcessByPidFile } from "../lib/process";

export async function sleep(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum sleep [<name>]");
    console.log("");
    console.log("Stop the assistant and gateway processes.");
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name>    Name of the assistant to stop (default: active or only local)",
    );
    process.exit(0);
  }

  const nameArg = args.find((a) => !a.startsWith("-"));
  const entry = resolveTargetAssistant(nameArg);

  if (entry.cloud && entry.cloud !== "local") {
    console.error(
      `Error: 'vellum sleep' only works with local assistants. '${entry.assistantId}' is a ${entry.cloud} instance.`,
    );
    process.exit(1);
  }

  const resources = entry.resources ?? defaultLocalResources();

  const daemonPidFile = resources.pidFile;
  const socketFile = resources.socketPath;
  const vellumDir = join(resources.instanceDir, ".vellum");
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
