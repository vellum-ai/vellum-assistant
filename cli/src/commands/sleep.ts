import { homedir } from "os";
import { join } from "path";

import { stopProcessByPidFile } from "../lib/process";

export async function sleep(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum sleep");
    console.log("");
    console.log("Stop the assistant, gateway, and outbound-proxy processes.");
    process.exit(0);
  }

  const vellumDir = join(homedir(), ".vellum");
  const daemonPidFile = join(vellumDir, "vellum.pid");
  const socketFile = join(vellumDir, "vellum.sock");
  const gatewayPidFile = join(vellumDir, "gateway.pid");
  const outboundProxyPidFile = join(vellumDir, "outbound-proxy.pid");

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

  // Stop outbound proxy
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
