import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  defaultLocalResources,
  resolveTargetAssistant,
} from "../lib/assistant-config.js";
import type { AssistantEntry } from "../lib/assistant-config.js";
import { isProcessAlive, stopProcessByPidFile } from "../lib/process";

const ACTIVE_CALL_LEASES_FILE = "active-call-leases.json";

type ActiveCallLease = {
  callSessionId: string;
};

function getAssistantRootDir(entry: AssistantEntry): string {
  const resources = entry.resources ?? defaultLocalResources();
  return entry.baseDataDir ?? join(resources.instanceDir, ".vellum");
}

function readActiveCallLeases(vellumDir: string): ActiveCallLease[] {
  const path = join(vellumDir, ACTIVE_CALL_LEASES_FILE);
  if (!existsSync(path)) {
    return [];
  }

  const raw = JSON.parse(readFileSync(path, "utf-8")) as {
    version?: number;
    leases?: Array<{ callSessionId?: unknown }>;
  };
  if (raw.version !== 1 || !Array.isArray(raw.leases)) {
    throw new Error(`Invalid active call lease file at ${path}`);
  }

  return raw.leases.filter(
    (lease): lease is ActiveCallLease =>
      typeof lease?.callSessionId === "string" && lease.callSessionId.length > 0
  );
}

export async function sleep(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum sleep [<name>] [--force]");
    console.log("");
    console.log("Stop the assistant and gateway processes.");
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name>    Name of the assistant to stop (default: active or only local)"
    );
    console.log("");
    console.log("Options:");
    console.log(
      "  --force   Stop the assistant even if a phone call keepalive lease is active"
    );
    process.exit(0);
  }

  const force = args.includes("--force");
  const nameArg = args.find((a) => !a.startsWith("-"));
  const entry = resolveTargetAssistant(nameArg);

  if (entry.cloud && entry.cloud !== "local") {
    console.error(
      `Error: 'vellum sleep' only works with local assistants. '${entry.assistantId}' is a ${entry.cloud} instance.`
    );
    process.exit(1);
  }

  const resources = entry.resources ?? defaultLocalResources();
  const assistantPidFile = resources.pidFile;
  const socketFile = resources.socketPath;
  const vellumDir = getAssistantRootDir(entry);
  const gatewayPidFile = join(vellumDir, "gateway.pid");

  if (!force) {
    const assistantAlive = isProcessAlive(assistantPidFile).alive;
    if (assistantAlive) {
      try {
        const activeCallLeases = readActiveCallLeases(vellumDir);
        if (activeCallLeases.length > 0) {
          const activeIds = activeCallLeases.map(
            (lease) => lease.callSessionId
          );
          console.error(
            `Error: assistant is staying awake for active phone calls (${activeIds.join(
              ", "
            )}). Use 'vellum sleep --force' to stop it anyway.`
          );
          process.exit(1);
        }
      } catch (err) {
        console.error(
          `Error: ${
            err instanceof Error ? err.message : String(err)
          }. Use 'vellum sleep --force' to override if you want to stop the assistant anyway.`
        );
        process.exit(1);
      }
    }
  }

  const assistantStopped = await stopProcessByPidFile(
    assistantPidFile,
    "assistant",
    [socketFile]
  );
  if (!assistantStopped) {
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
    7000
  );
  if (!gatewayStopped) {
    console.log("Gateway is not running.");
  } else {
    console.log("Gateway stopped.");
  }
}
