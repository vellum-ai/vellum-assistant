import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import {
  DEFAULT_DAEMON_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_QDRANT_PORT,
} from "./constants.js";
import { probePort } from "./port-probe.js";

/**
 * Per-instance resource paths and ports. Each local assistant instance gets
 * its own directory tree, ports, and socket so multiple instances can run
 * side-by-side without conflicts.
 */
export interface LocalInstanceResources {
  /**
   * Instance-specific data root. The first local assistant uses `~` (workspace
   * at `~/.vellum`); subsequent assistants use
   * `~/.local/share/vellum/assistants/<name>/` (workspace at
   * `~/.local/share/vellum/assistants/<name>/.vellum`).
   * The daemon's `.vellum/` directory lives inside it.
   */
  instanceDir: string;
  /** HTTP port for the daemon runtime server */
  daemonPort: number;
  /** HTTP port for the gateway */
  gatewayPort: number;
  /** HTTP port for the Qdrant vector store */
  qdrantPort: number;
  /** Absolute path to the Unix domain socket for IPC */
  socketPath: string;
  /** Absolute path to the daemon PID file */
  pidFile: string;
}

export interface AssistantEntry {
  assistantId: string;
  runtimeUrl: string;
  /** Loopback URL for same-machine health checks (e.g. `http://127.0.0.1:7831`).
   *  Avoids mDNS resolution issues when the machine checks its own gateway. */
  localUrl?: string;
  bearerToken?: string;
  cloud: string;
  instanceId?: string;
  namespace?: string;
  project?: string;
  region?: string;
  species?: string;
  sshUser?: string;
  zone?: string;
  hatchedAt?: string;
  /** Per-instance resource config. Present for local entries in multi-instance setups. */
  resources?: LocalInstanceResources;
}

interface LockfileData {
  assistants?: AssistantEntry[];
  activeAssistant?: string;
  platformBaseUrl?: string;
  [key: string]: unknown;
}

function getBaseDir(): string {
  return process.env.BASE_DATA_DIR?.trim() || homedir();
}

function readLockfile(): LockfileData {
  const base = getBaseDir();
  const candidates = [
    join(base, ".vellum.lock.json"),
    join(base, ".vellum.lockfile.json"),
  ];
  for (const lockfilePath of candidates) {
    if (!existsSync(lockfilePath)) continue;
    try {
      const raw = readFileSync(lockfilePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as LockfileData;
      }
    } catch {
      // Malformed lockfile; try next
    }
  }
  return {};
}

function writeLockfile(data: LockfileData): void {
  const lockfilePath = join(getBaseDir(), ".vellum.lock.json");
  writeFileSync(lockfilePath, JSON.stringify(data, null, 2) + "\n");
}

function readAssistants(): AssistantEntry[] {
  const data = readLockfile();
  const entries = data.assistants;
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.filter(
    (e) =>
      typeof e.assistantId === "string" && typeof e.runtimeUrl === "string",
  );
}

function writeAssistants(entries: AssistantEntry[]): void {
  const data = readLockfile();
  data.assistants = entries;
  writeLockfile(data);
}

export function loadLatestAssistant(): AssistantEntry | null {
  const entries = readAssistants();
  if (entries.length === 0) {
    return null;
  }
  const sorted = [...entries].sort((a, b) => {
    const ta = a.hatchedAt ? new Date(a.hatchedAt).getTime() : 0;
    const tb = b.hatchedAt ? new Date(b.hatchedAt).getTime() : 0;
    return tb - ta;
  });
  return sorted[0];
}

export function findAssistantByName(name: string): AssistantEntry | null {
  const entries = readAssistants();
  return entries.find((e) => e.assistantId === name) ?? null;
}

export function removeAssistantEntry(assistantId: string): void {
  const data = readLockfile();
  const entries = (data.assistants ?? []).filter(
    (e: AssistantEntry) => e.assistantId !== assistantId,
  );
  data.assistants = entries;
  // Clear active assistant if it matches the removed entry
  if (data.activeAssistant === assistantId) {
    delete data.activeAssistant;
  }
  writeLockfile(data);
}

export function loadAllAssistants(): AssistantEntry[] {
  return readAssistants();
}

export function getActiveAssistant(): string | null {
  const data = readLockfile();
  return data.activeAssistant ?? null;
}

export function setActiveAssistant(assistantId: string): void {
  const data = readLockfile();
  data.activeAssistant = assistantId;
  writeLockfile(data);
}

/**
 * Resolve which assistant to target for a command. Priority:
 * 1. Explicit name argument
 * 2. Active assistant set via `vellum use`
 * 3. Sole local assistant (when exactly one exists)
 */
export function resolveTargetAssistant(nameArg?: string): AssistantEntry {
  if (nameArg) {
    const entry = findAssistantByName(nameArg);
    if (!entry) {
      console.error(`No assistant found with name '${nameArg}'.`);
      process.exit(1);
    }
    return entry;
  }

  const active = getActiveAssistant();
  if (active) {
    const entry = findAssistantByName(active);
    if (entry) return entry;
    // Active assistant no longer exists in lockfile — fall through
  }

  const all = readAssistants();
  const locals = all.filter((e) => e.cloud === "local");
  if (locals.length === 1) return locals[0];

  if (locals.length === 0) {
    console.error("No local assistant found. Run 'vellum hatch local' first.");
  } else {
    console.error(
      `Multiple assistants found. Set an active assistant with 'vellum use <name>'.`,
    );
  }
  process.exit(1);
}

export function saveAssistantEntry(entry: AssistantEntry): void {
  const entries = readAssistants().filter(
    (e) => e.assistantId !== entry.assistantId,
  );
  entries.unshift(entry);
  writeAssistants(entries);
}

/**
 * Scan upward from `basePort` to find an available port. A port is considered
 * available when `probePort()` returns false (nothing listening). Scans up to
 * 100 ports above the base before giving up.
 */
async function findAvailablePort(
  basePort: number,
  excludedPorts: number[] = [],
): Promise<number> {
  const maxOffset = 100;
  for (let offset = 0; offset < maxOffset; offset++) {
    const port = basePort + offset;
    if (excludedPorts.includes(port)) continue;
    const inUse = await probePort(port);
    if (!inUse) return port;
  }
  throw new Error(
    `Could not find an available port scanning from ${basePort} to ${basePort + maxOffset - 1}`,
  );
}

/**
 * Allocate an isolated set of resources for a named local instance.
 * Each assistant is placed under
 * `~/.local/share/vellum/assistants/<name>/` with scanned ports.
 */
export async function allocateLocalResources(
  instanceName: string,
): Promise<LocalInstanceResources> {
  const instanceDir = join(
    homedir(),
    ".local",
    "share",
    "vellum",
    "assistants",
    instanceName,
  );
  mkdirSync(instanceDir, { recursive: true });

  // Collect ports already assigned to other local instances in the lockfile.
  // Even if those instances are stopped, we must avoid reusing their ports
  // to prevent binding collisions when both are woken.
  const reservedPorts: number[] = [];
  for (const entry of loadAllAssistants()) {
    if (entry.cloud !== "local") continue;
    if (entry.resources) {
      reservedPorts.push(
        entry.resources.daemonPort,
        entry.resources.gatewayPort,
        entry.resources.qdrantPort,
      );
    }
  }

  // Allocate ports sequentially to avoid overlapping ranges assigning the
  // same port to multiple services (e.g. daemon 7821-7920 overlaps gateway 7830-7929).
  const daemonPort = await findAvailablePort(
    DEFAULT_DAEMON_PORT,
    reservedPorts,
  );
  const gatewayPort = await findAvailablePort(DEFAULT_GATEWAY_PORT, [
    ...reservedPorts,
    daemonPort,
  ]);
  const qdrantPort = await findAvailablePort(DEFAULT_QDRANT_PORT, [
    ...reservedPorts,
    daemonPort,
    gatewayPort,
  ]);

  return {
    instanceDir,
    daemonPort,
    gatewayPort,
    qdrantPort,
    socketPath: join(instanceDir, ".vellum", "vellum.sock"),
    pidFile: join(instanceDir, ".vellum", "vellum.pid"),
  };
}

/**
 * Read the assistant config file and sync client-relevant values to the
 * lockfile. This lets external tools (e.g. vel) discover the platform URL
 * without importing the assistant config schema.
 */
export function syncConfigToLockfile(): void {
  const configPath = join(getBaseDir(), ".vellum", "workspace", "config.json");
  if (!existsSync(configPath)) return;

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const platform = raw.platform as Record<string, unknown> | undefined;
    const data = readLockfile();
    data.platformBaseUrl = (platform?.baseUrl as string) || undefined;
    writeLockfile(data);
  } catch {
    // Config file unreadable — skip sync
  }
}
