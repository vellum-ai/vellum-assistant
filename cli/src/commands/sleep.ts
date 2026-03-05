import { homedir } from "os";
import { join } from "path";

import {
  defaultLocalResources,
  loadAllAssistants,
  resolveTargetAssistant,
} from "../lib/assistant-config.js";
import { isProcessAlive, stopProcessByPidFile } from "../lib/process";

export async function sleep(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum sleep [<name>]");
    console.log("");
    console.log("Stop the assistant, gateway, and outbound-proxy processes.");
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
  // Outbound proxy is a shared singleton — always use the global PID path
  const outboundProxyPidFile = join(homedir(), ".vellum", "outbound-proxy.pid");

  // Stop daemon
  const daemonStopped = await stopProcessByPidFile(daemonPidFile, "daemon", [
    socketFile,
  ]);
  if (!daemonStopped) {
    console.log("Assistant is not running.");
  } else {
    console.log("Assistant stopped.");
  }

  // Stop gateway
  const gatewayStopped = await stopProcessByPidFile(gatewayPidFile, "gateway");
  if (!gatewayStopped) {
    console.log("Gateway is not running.");
  } else {
    console.log("Gateway stopped.");
  }

  // Only stop the shared outbound proxy if no other local assistants still
  // have a running daemon — the proxy is a global singleton shared by all
  // instances.
  const otherLocalRunning = loadAllAssistants().some((other) => {
    if (other.cloud !== "local" || !other.resources) return false;
    if (other.assistantId === entry.assistantId) return false;
    return isProcessAlive(other.resources.pidFile).alive;
  });

  if (otherLocalRunning) {
    console.log("Outbound proxy left running (other local instances active).");
  } else {
    const outboundProxyStopped = await stopProcessByPidFile(
      outboundProxyPidFile,
      "outbound-proxy",
    );
    if (!outboundProxyStopped) {
      console.log("Outbound proxy is not running.");
    } else {
      console.log("Outbound proxy stopped.");
    }
  }
}
