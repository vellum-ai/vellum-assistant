import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";

import { SEEDS } from "@vellumai/environments";

import type {
  LockfileAssistant,
} from "./lockfile-contract";
import { getLockfileData } from "./lockfile";

const HEALTH_TIMEOUT_MS = 1_500;
const STARTING_GRACE_MS = 60_000;
const PRODUCTION_ENVIRONMENT_NAME = "production";
const DEFAULT_PORTS = {
  daemon: 7821,
  gateway: 7830,
};

export type LocalAssistantRuntimeState =
  | "healthy"
  | "upgrading"
  | "sleeping"
  | "starting"
  | "crashed"
  | "unknown";

export type LocalAssistantStatusResult =
  | {
      ok: true;
      state: LocalAssistantRuntimeState;
      detail?: string;
      pid?: number;
    }
  | { ok: false; status: number; error: string };

type PidState =
  | { state: "missing" }
  | { state: "starting"; updatedAtMs: number }
  | { state: "alive"; pid: number; updatedAtMs: number }
  | { state: "dead"; pid: number; updatedAtMs: number }
  | { state: "invalid"; value: string; updatedAtMs: number };

interface StatusResources {
  instanceDir: string;
  gatewayPort: number;
  daemonPort: number;
}

function getDaemonPidPath(instanceDir: string): string {
  return path.join(instanceDir, ".vellum", "workspace", "vellum.pid");
}

function getGatewayPidPath(instanceDir: string): string {
  return path.join(instanceDir, ".vellum", "gateway.pid");
}

function readPidState(pidFile: string): PidState {
  if (!existsSync(pidFile)) return { state: "missing" };

  const updatedAtMs = statSync(pidFile).mtimeMs;
  const value = readFileSync(pidFile, "utf-8").trim();
  if (!value) return { state: "missing" };
  if (value === "starting") return { state: "starting", updatedAtMs };

  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: "invalid", value, updatedAtMs };
  }

  try {
    process.kill(pid, 0);
    return { state: "alive", pid, updatedAtMs };
  } catch {
    return { state: "dead", pid, updatedAtMs };
  }
}

function isFreshPidState(
  pidState: PidState,
  observedAtMs: number,
): boolean {
  return (
    "updatedAtMs" in pidState &&
    observedAtMs - pidState.updatedAtMs <= STARTING_GRACE_MS
  );
}

function httpHealthCheck(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/healthz",
        timeout: HEALTH_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve(false);
            return;
          }

          try {
            const body = JSON.parse(Buffer.concat(chunks).toString()) as {
              status?: string;
            };
            resolve(
              body.status === undefined ||
                body.status === "healthy" ||
                body.status === "ok",
            );
          } catch {
            resolve(true);
          }
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function localOnlyEntry(
  entry: LockfileAssistant | undefined,
): LockfileAssistant | null {
  if (!entry || (entry.cloud != null && entry.cloud !== "local")) return null;
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePortFromUrl(url: unknown): number | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function defaultPorts(env: Record<string, string | undefined>): {
  daemon: number;
  gateway: number;
} {
  const envName = env.VELLUM_ENVIRONMENT?.trim() || PRODUCTION_ENVIRONMENT_NAME;
  const seed = SEEDS[envName] ?? SEEDS[PRODUCTION_ENVIRONMENT_NAME];
  return {
    daemon: seed?.portsOverride?.daemon ?? DEFAULT_PORTS.daemon,
    gateway: seed?.portsOverride?.gateway ?? DEFAULT_PORTS.gateway,
  };
}

function defaultInstanceDir(
  env: Record<string, string | undefined>,
  assistantId: string,
): string {
  const envName = env.VELLUM_ENVIRONMENT?.trim() || PRODUCTION_ENVIRONMENT_NAME;
  const xdgDataHome =
    env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  const dataRoot =
    envName === PRODUCTION_ENVIRONMENT_NAME ? "vellum" : `vellum-${envName}`;
  return path.join(xdgDataHome, dataRoot, "assistants", assistantId);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function findRawAssistant(
  lockfilePaths: string[],
  assistantId: string,
): Record<string, unknown> | null {
  for (const candidate of lockfilePaths) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(candidate, "utf-8"));
    } catch {
      continue;
    }
    if (!isRecord(data) || !Array.isArray(data.assistants)) return null;
    const entry = data.assistants.find(
      (assistant) =>
        isRecord(assistant) && assistant.assistantId === assistantId,
    );
    return isRecord(entry) ? entry : null;
  }
  return null;
}

function resolveStatusResources(
  entry: LockfileAssistant,
  rawEntry: Record<string, unknown> | null,
  env: Record<string, string | undefined>,
): StatusResources {
  const rawResources = isRecord(rawEntry?.resources)
    ? rawEntry.resources
    : undefined;
  const ports = defaultPorts(env);
  const instanceDir =
    firstString(
      entry.resources?.instanceDir,
      rawResources?.instanceDir,
      rawEntry?.baseDataDir,
    ) ?? defaultInstanceDir(env, entry.assistantId);
  return {
    instanceDir,
    daemonPort:
      firstNumber(entry.resources?.daemonPort, rawResources?.daemonPort) ??
      ports.daemon,
    gatewayPort:
      firstNumber(entry.resources?.gatewayPort, rawResources?.gatewayPort) ??
      parsePortFromUrl(rawEntry?.localUrl) ??
      parsePortFromUrl(rawEntry?.runtimeUrl ?? entry.runtimeUrl) ??
      ports.gateway,
  };
}

async function runtimeStatusForEntry(
  entry: LockfileAssistant,
  rawEntry: Record<string, unknown> | null,
  env: Record<string, string | undefined>,
): Promise<LocalAssistantStatusResult> {
  const resources = resolveStatusResources(entry, rawEntry, env);
  const observedAtMs = Date.now();

  const assistantPid = readPidState(getDaemonPidPath(resources.instanceDir));
  if (assistantPid.state === "missing") {
    return { ok: true, state: "sleeping" };
  }
  if (assistantPid.state === "starting") {
    return { ok: true, state: "starting" };
  }
  if (assistantPid.state === "dead") {
    return { ok: true, state: "sleeping", pid: assistantPid.pid };
  }
  if (assistantPid.state === "invalid") {
    return {
      ok: true,
      state: "crashed",
      detail: "assistant PID file is invalid",
    };
  }

  const assistantHealthy = await httpHealthCheck(resources.daemonPort);
  if (!assistantHealthy) {
    if (isFreshPidState(assistantPid, observedAtMs)) {
      return { ok: true, state: "starting", pid: assistantPid.pid };
    }
    return {
      ok: true,
      state: "crashed",
      pid: assistantPid.pid,
      detail: "assistant process is not responding",
    };
  }

  const gatewayPid = readPidState(getGatewayPidPath(resources.instanceDir));
  if (gatewayPid.state === "starting") {
    return { ok: true, state: "starting", pid: assistantPid.pid };
  }
  if (gatewayPid.state !== "alive") {
    if (
      isFreshPidState(assistantPid, observedAtMs) ||
      isFreshPidState(gatewayPid, observedAtMs)
    ) {
      return { ok: true, state: "starting", pid: assistantPid.pid };
    }
    return {
      ok: true,
      state: "crashed",
      pid: assistantPid.pid,
      detail: "gateway process is not running",
    };
  }

  const gatewayHealthy = await httpHealthCheck(resources.gatewayPort);
  if (!gatewayHealthy) {
    if (isFreshPidState(gatewayPid, observedAtMs)) {
      return { ok: true, state: "starting", pid: gatewayPid.pid };
    }
    return {
      ok: true,
      state: "crashed",
      pid: gatewayPid.pid,
      detail: "gateway process is not responding",
    };
  }

  return { ok: true, state: "healthy", pid: assistantPid.pid };
}

export async function getLocalAssistantStatus(
  lockfilePaths: string[],
  assistantId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<LocalAssistantStatusResult> {
  const result = getLockfileData(lockfilePaths);
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error ?? "Failed to read lockfile",
    };
  }

  const entry = localOnlyEntry(
    result.data.assistants.find(
      (assistant) => assistant.assistantId === assistantId,
    ),
  );
  if (!entry) {
    return { ok: false, status: 404, error: "Local assistant not found" };
  }

  return runtimeStatusForEntry(
    entry,
    findRawAssistant(lockfilePaths, assistantId),
    env,
  );
}
