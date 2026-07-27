import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  getDaemonPidPath,
  resolveTargetAssistant,
} from "../lib/assistant-config.js";
import type { AssistantEntry } from "../lib/assistant-config.js";
import { dockerResourceNames, sleepContainers } from "../lib/docker.js";
import {
  drainAssistant,
  type DrainOutcome,
  parseWaitDuration,
} from "../lib/drain.js";
import { loadGuardianToken } from "../lib/guardian-token.js";
import { stopIngressNginx } from "../lib/nginx-ingress.js";
import { isProcessAlive, stopProcessByPidFile } from "../lib/process";
import { resolveFreshBearerToken } from "./client.js";

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
    console.log("Usage: vellum sleep [<name>] [--force] [--wait [<duration>]]");
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
    console.log(
      "  --wait    Wait for in-flight background work (heartbeats, memory jobs,",
    );
    console.log(
      "            schedules) to finish before stopping. Waits as long as it",
    );
    console.log(
      "            takes by default; pass a duration (e.g. --wait 90s, --wait 10m)",
    );
    console.log(
      "            to bound the wait. Ctrl-C cancels and leaves the assistant running.",
    );
    process.exit(0);
  }

  const force = args.includes("--force");
  let wait = false;
  let waitMs: number | null = null;
  let waitDurationToken: string | null = null;
  const waitEqArg = args.find((a) => a.startsWith("--wait="));
  if (waitEqArg) {
    wait = true;
    const raw = waitEqArg.slice("--wait=".length);
    waitMs = parseWaitDuration(raw);
    if (waitMs == null) {
      console.error(
        `Error: invalid --wait duration '${raw}'. Use seconds or a value like 90s or 10m.`,
      );
      process.exit(1);
    }
  } else {
    const waitIndex = args.indexOf("--wait");
    if (waitIndex !== -1) {
      wait = true;
      // A bare `--wait` waits indefinitely; a following duration token
      // (e.g. `90s`, `10m`, `120`) bounds it. Anything else is the name arg.
      const next = args[waitIndex + 1];
      if (next !== undefined && /^\d+(s|m)?$/.test(next)) {
        waitDurationToken = next;
        waitMs = parseWaitDuration(next);
        if (waitMs == null) {
          console.error(
            `Error: invalid --wait duration '${next}'. Use seconds or a value like 90s or 10m.`,
          );
          process.exit(1);
        }
      }
    }
  }
  const nameArg = args.find(
    (a) => !a.startsWith("-") && a !== waitDurationToken,
  );
  const entry = resolveTargetAssistant(nameArg);

  if (entry.cloud === "docker") {
    if (wait) {
      console.log(
        "--wait is not supported for Docker assistants yet — stopping containers now.",
      );
    }
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

  if (wait) {
    const outcome = await runDrainPhase(entry, assistantPidFile, waitMs);
    if (outcome === "cancelled") {
      console.log("Sleep cancelled — the assistant is still running.");
      process.exit(130);
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

/**
 * Wait for the assistant's in-flight background work (heartbeats, memory
 * jobs, schedule runs, active conversation turns) to finish before the stop.
 * Every failure mode falls back to a normal stop with a note — a drain must
 * never make `vellum sleep` less reliable than it is without `--wait`.
 */
async function runDrainPhase(
  entry: AssistantEntry,
  assistantPidFile: string,
  waitMs: number | null,
): Promise<DrainOutcome | "skipped"> {
  if (!isProcessAlive(assistantPidFile).alive) {
    return "skipped";
  }
  const baseUrl = entry.localUrl ?? entry.runtimeUrl;
  const stored = loadGuardianToken(entry.assistantId)?.accessToken;
  if (!baseUrl || !stored) {
    console.log(
      "Cannot reach the assistant API to wait for background work (missing URL or guardian token) — stopping without waiting.",
    );
    return "skipped";
  }
  // A token past its renewal point would 401 and read as "unreachable",
  // silently skipping the wait — refresh-and-fall-back like other CLI
  // request paths.
  const token = await resolveFreshBearerToken(
    baseUrl,
    entry.assistantId,
    stored,
    entry.cloud,
  );
  if (!token) {
    console.log(
      "Cannot reach the assistant API to wait for background work (missing URL or guardian token) — stopping without waiting.",
    );
    return "skipped";
  }

  console.log(
    waitMs == null
      ? "Waiting for the assistant to finish background work (Ctrl-C cancels)…"
      : `Waiting up to ${Math.round(waitMs / 1000)}s for the assistant to finish background work (Ctrl-C cancels)…`,
  );

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    const outcome = await drainAssistant({
      baseUrl,
      token,
      deadlineAt: waitMs == null ? null : Date.now() + waitMs,
      signal: controller.signal,
    });
    switch (outcome) {
      case "drained":
        console.log("Background work finished — stopping now.");
        break;
      case "timeout":
        console.log(
          "Wait limit reached — stopping now. Interrupted background jobs resume after the next start.",
        );
        break;
      case "unsupported":
        console.log(
          "This assistant version does not support --wait — stopping without waiting.",
        );
        break;
      case "unreachable":
        console.log(
          "Could not reach the assistant to check background work — stopping without waiting.",
        );
        break;
      case "cancelled":
        break;
    }
    return outcome;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
