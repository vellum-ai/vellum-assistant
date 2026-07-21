import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  getDaemonPidPath,
  resolveTargetAssistant,
} from "../lib/assistant-config.js";
import type { AssistantEntry } from "../lib/assistant-config.js";
import { dockerResourceNames, sleepContainers } from "../lib/docker.js";
import { stopIngressNginx } from "../lib/nginx-ingress.js";
import { isProcessAlive, stopProcessByPidFile } from "../lib/process";

const ACTIVE_CALL_LEASES_FILE = "active-call-leases.json";

type ActiveCallLease = {
  callSessionId: string;
};

function getAssistantRootDir(entry: AssistantEntry): string {
  if (!entry.resources) {
    throw new Error(
      `Local assistant '${entry.assistantId}' is missing resource configuration. Re-hatch to fix.`,
    );
  }
  return join(entry.resources.instanceDir, ".vellum");
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
      typeof lease?.callSessionId === "string" &&
      lease.callSessionId.length > 0,
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
      "  <name>    Name of the assistant to stop (default: active or only local)",
    );
    console.log("");
    console.log("Options:");
    console.log(
      "  --force   Stop the assistant even if a phone call keepalive lease is active",
    );
    process.exit(0);
  }

  const force = args.includes("--force");
  const nameArg = args.find((a) => !a.startsWith("-"));
  const entry = resolveTargetAssistant(nameArg);

  if (entry.cloud === "docker") {
    const res = dockerResourceNames(entry.assistantId);
    await sleepContainers(res);
    console.log("Docker containers stopped.");
    return;
  }

  if (entry.cloud === "apple-container") {
    console.error(
      `Error: '${entry.assistantId}' uses the Apple Containers runtime. Its lifecycle is managed by the macOS app — use the app to stop it.`,
    );
    process.exit(1);
  }

  if (entry.cloud === "paired") {
    console.error(
      `Error: '${entry.assistantId}' is a remote assistant paired from another machine — its lifecycle is managed on its host machine, not here. Use \`vellum client ${entry.assistantId}\` to chat with it.`,
    );
    process.exit(1);
  }

  if (entry.cloud && entry.cloud !== "local") {
    console.error(
      `Error: 'vellum sleep' only works with local and docker assistants. '${entry.assistantId}' is a ${entry.cloud} instance.`,
    );
    process.exit(1);
  }

  if (!entry.resources) {
    console.error(
      `Error: Local assistant '${entry.assistantId}' is missing resource configuration. Re-hatch to fix.`,
    );
    process.exit(1);
  }
  const resources = entry.resources;
  const assistantPidFile = getDaemonPidPath(resources);
  const vellumDir = getAssistantRootDir(entry);
  const gatewayPidFile = join(vellumDir, "gateway.pid");

  if (!force) {
    const assistantAlive = isProcessAlive(assistantPidFile).alive;
    if (assistantAlive) {
      try {
        const activeCallLeases = readActiveCallLeases(vellumDir);
        if (activeCallLeases.length > 0) {
          const activeIds = activeCallLeases.map(
            (lease) => lease.callSessionId,
          );
          console.error(
            `Error: assistant is staying awake for active phone calls (${activeIds.join(
              ", ",
            )}). Use 'vellum sleep --force' to stop it anyway.`,
          );
          process.exit(1);
        }
      } catch (err) {
        console.error(
          `Error: ${
            err instanceof Error ? err.message : String(err)
          }. Use 'vellum sleep --force' to override if you want to stop the assistant anyway.`,
        );
        process.exit(1);
      }
    }
  }

  // Stop assistant — use a generous timeout. On SIGTERM the daemon runs a
  // WAL checkpoint before exiting, which can take several seconds on a
  // multi-GB database. The default 2s grace in stopProcess() would SIGKILL a
  // healthy daemon mid-checkpoint, forcing a costly multi-minute WAL recovery
  // on the next start. The timeout is only a SIGKILL ceiling — stopProcess
  // returns as soon as the process exits, so this adds no delay in the common
  // case and only applies when the daemon is genuinely wedged.
  const assistantStopped = await stopProcessByPidFile(
    assistantPidFile,
    "assistant",
    undefined,
    120_000,
  );
  if (!assistantStopped) {
    console.log("Assistant is not running.");
  } else {
    console.log("Assistant stopped.");
  }

  // Stop gateway — use a longer timeout because the gateway has a configurable
  // drain window (5s) before it exits.
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

  // Stop the CES sibling — it is stopped by its PID file, a no-op when the
  // PID file is absent (e.g. the sibling was never started or already exited).
  const cesPidFile = join(vellumDir, "ces.pid");
  const cesStopped = await stopProcessByPidFile(
    cesPidFile,
    "credential-executor",
  );
  if (cesStopped) {
    console.log("credential-executor stopped.");
  }

  // Stop the nginx ingress if one is fronting this gateway — otherwise it
  // keeps running against a dead upstream and serves 502s.
  const ingressStopped = await stopIngressNginx(join(vellumDir, "workspace"));
  if (ingressStopped) {
    console.log("nginx ingress stopped.");
  }
}
