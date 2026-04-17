import { randomBytes } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import {
  DAEMON_INTERNAL_ASSISTANT_ID,
  DEFAULT_CES_PORT,
  DEFAULT_DAEMON_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_QDRANT_PORT,
} from "./constants.js";
import {
  getLockfilePath,
  getLockfilePaths,
  getMultiInstanceDir,
} from "./environments/paths.js";
import { getCurrentEnvironment } from "./environments/resolve.js";
import { probePort } from "./port-probe.js";

/**
 * Per-instance resource paths and ports. Each local assistant instance gets
 * its own directory tree, ports, and socket so multiple instances can run
 * side-by-side without conflicts.
 */
export interface LocalInstanceResources {
  /**
   * Instance-specific data root. New local assistants are placed under
   * `$XDG_DATA_HOME/vellum{-env}/assistants/<name>/`. Legacy entries
   * (pre env-data-layout) may still point at `~` — the read path honors
   * whatever `instanceDir` is stored. The daemon's `.vellum/` directory
   * lives inside it.
   */
  instanceDir: string;
  /** HTTP port for the daemon runtime server */
  daemonPort: number;
  /** HTTP port for the gateway */
  gatewayPort: number;
  /** HTTP port for the Qdrant vector store */
  qdrantPort: number;
  /** HTTP port for the CES (Claude Extension Server) */
  cesPort: number;
  /** Absolute path to the daemon PID file */
  pidFile: string;
  /** Persisted HMAC signing key (hex). Survives daemon/gateway restarts so
   *  client actor tokens remain valid across `wake` cycles. */
  signingKey?: string;
  [key: string]: unknown;
}

/** Docker image metadata for the service group. Enables rollback to known-good digests. */
export interface ContainerInfo {
  assistantImage: string;
  gatewayImage: string;
  cesImage: string;
  /** sha256 digest of the assistant image at time of hatch/upgrade */
  assistantDigest?: string;
  /** sha256 digest of the gateway image at time of hatch/upgrade */
  gatewayDigest?: string;
  /** sha256 digest of the CES image at time of hatch/upgrade */
  cesDigest?: string;
  /** Docker network name for the service group */
  networkName?: string;
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
  /** PID of the file watcher process for docker instances hatched with --watch. */
  watcherPid?: number;
  /** Docker image metadata for rollback. Only present for docker topology entries. */
  containerInfo?: ContainerInfo;
  /** Docker image metadata from before the last upgrade. Enables rollback to the prior version. */
  previousContainerInfo?: ContainerInfo;
  /** Path to the .vbundle backup created for the most recent upgrade. Used by rollback to restore
   *  only the backup from the specific upgrade being rolled back — never a stale backup from a
   *  previous upgrade cycle. */
  preUpgradeBackupPath?: string;
  /** Running version of the service group at the time of the last upgrade, as reported by
   *  the health endpoint.  Used by saved-state rollback for logging / broadcast events. */
  previousVersion?: string;
  /** Pre-upgrade DB migration version — used by rollback to know how far back to revert. */
  previousDbMigrationVersion?: number;
  /** Pre-upgrade workspace migration ID — used by rollback to know how far back to revert. */
  previousWorkspaceMigrationId?: string;
  [key: string]: unknown;
}

interface LockfileData {
  assistants?: Record<string, unknown>[];
  activeAssistant?: string;
  platformBaseUrl?: string;
  [key: string]: unknown;
}

export function getBaseDir(): string {
  return process.env.BASE_DATA_DIR?.trim() || homedir();
}

function readLockfile(): LockfileData {
  for (const lockfilePath of getLockfilePaths(getCurrentEnvironment())) {
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
  const lockfilePath = getLockfilePath(getCurrentEnvironment());
  mkdirSync(dirname(lockfilePath), { recursive: true });
  const tmpPath = `${lockfilePath}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
    renameSync(tmpPath, lockfilePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

/**
 * Try to extract a port number from a URL string (e.g. `http://localhost:7830`).
 * Returns undefined if the URL is malformed or has no explicit port.
 */
function parsePortFromUrl(url: unknown): number | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    const port = parseInt(parsed.port, 10);
    return isNaN(port) ? undefined : port;
  } catch {
    return undefined;
  }
}

/**
 * Detect and migrate legacy lockfile entries to the current format.
 *
 * Legacy entries stored `baseDataDir` as a top-level field. The current
 * format nests this under `resources.instanceDir`. This function also
 * synthesises a full `resources` object when one is missing by inferring
 * ports from the entry's `runtimeUrl` and falling back to defaults.
 *
 * Returns `true` if the entry was mutated (so the caller can persist).
 */
export function migrateLegacyEntry(raw: Record<string, unknown>): boolean {
  if (typeof raw.cloud === "string" && raw.cloud !== "local") {
    return false;
  }

  // Apple-containers entries are fully managed by the macOS app.
  // Skip legacy migration to avoid corrupting their fields.
  if (raw.cloud === "apple-container") {
    return false;
  }

  const env = getCurrentEnvironment();
  let mutated = false;

  // Migrate top-level `baseDataDir` → `resources.instanceDir`
  if (typeof raw.baseDataDir === "string" && raw.baseDataDir) {
    if (!raw.resources || typeof raw.resources !== "object") {
      raw.resources = {};
    }
    const res = raw.resources as Record<string, unknown>;
    if (!res.instanceDir) {
      res.instanceDir = raw.baseDataDir;
      mutated = true;
    }
    delete raw.baseDataDir;
    mutated = true;
  }

  // Synthesise missing `resources` for local entries
  if (!raw.resources || typeof raw.resources !== "object") {
    const gatewayPort =
      parsePortFromUrl(raw.runtimeUrl) ?? DEFAULT_GATEWAY_PORT;
    const instanceDir = join(
      getMultiInstanceDir(env),
      typeof raw.assistantId === "string"
        ? raw.assistantId
        : DAEMON_INTERNAL_ASSISTANT_ID,
    );
    raw.resources = {
      instanceDir,
      daemonPort: DEFAULT_DAEMON_PORT,
      gatewayPort,
      qdrantPort: DEFAULT_QDRANT_PORT,
      cesPort: DEFAULT_CES_PORT,
      pidFile: join(instanceDir, ".vellum", "vellum.pid"),
    };
    mutated = true;
  } else {
    // Backfill any missing fields on an existing partial `resources` object
    const res = raw.resources as Record<string, unknown>;
    if (!res.instanceDir) {
      res.instanceDir = join(
        getMultiInstanceDir(env),
        typeof raw.assistantId === "string"
          ? raw.assistantId
          : DAEMON_INTERNAL_ASSISTANT_ID,
      );
      mutated = true;
    }
    if (typeof res.daemonPort !== "number") {
      res.daemonPort = DEFAULT_DAEMON_PORT;
      mutated = true;
    }
    if (typeof res.gatewayPort !== "number") {
      res.gatewayPort =
        parsePortFromUrl(raw.runtimeUrl) ?? DEFAULT_GATEWAY_PORT;
      mutated = true;
    }
    if (typeof res.qdrantPort !== "number") {
      res.qdrantPort = DEFAULT_QDRANT_PORT;
      mutated = true;
    }
    if (typeof res.cesPort !== "number") {
      res.cesPort = DEFAULT_CES_PORT;
      mutated = true;
    }
    if (typeof res.pidFile !== "string") {
      res.pidFile = join(res.instanceDir as string, ".vellum", "vellum.pid");
      mutated = true;
    }
  }

  return mutated;
}

function readAssistants(): AssistantEntry[] {
  const data = readLockfile();
  const entries = data.assistants;
  if (!Array.isArray(entries)) {
    return [];
  }

  let migrated = false;
  for (const entry of entries) {
    if (migrateLegacyEntry(entry)) {
      migrated = true;
    }
  }

  if (migrated) {
    writeLockfile(data);
  }

  return entries.filter(
    (e): e is AssistantEntry =>
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
    (e) => e.assistantId !== assistantId,
  );
  data.assistants = entries;
  // Reassign active assistant if it matches the removed entry
  if (data.activeAssistant === assistantId) {
    const remaining = entries[0];
    if (remaining) {
      data.activeAssistant = String(remaining.assistantId);
    } else {
      delete data.activeAssistant;
    }
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

/**
 * Determine which cloud topology an assistant entry is running on.
 */
export function resolveCloud(entry: AssistantEntry): string {
  if (entry.cloud) {
    return entry.cloud;
  }
  if (entry.project) {
    return "gcp";
  }
  if (entry.sshUser) {
    return "custom";
  }
  return "local";
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
 * Every new local assistant is allocated under
 * `$XDG_DATA_HOME/vellum{-env}/assistants/<name>/`. The legacy `~/.vellum/`
 * path is only reached via existing lockfile entries from before this change
 * — the read path honors whatever `resources.instanceDir` is stored, so
 * production users' existing first-local assistants keep their `~/.vellum/`
 * roots unchanged.
 */
export async function allocateLocalResources(
  instanceName: string,
): Promise<LocalInstanceResources> {
  const env = getCurrentEnvironment();
  const instanceDir = join(getMultiInstanceDir(env), instanceName);
  mkdirSync(instanceDir, { recursive: true });

  // Collect ports already assigned to other local instances in the lockfile.
  const reservedPorts: number[] = [];
  for (const entry of loadAllAssistants()) {
    if (entry.cloud !== "local" || !entry.resources) continue;
    reservedPorts.push(
      entry.resources.daemonPort,
      entry.resources.gatewayPort,
      entry.resources.qdrantPort,
      entry.resources.cesPort,
    );
  }

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
  const cesPort = await findAvailablePort(DEFAULT_CES_PORT, [
    ...reservedPorts,
    daemonPort,
    gatewayPort,
    qdrantPort,
  ]);

  return {
    instanceDir,
    daemonPort,
    gatewayPort,
    qdrantPort,
    cesPort,
    pidFile: join(instanceDir, ".vellum", "vellum.pid"),
  };
}

/**
 * Return `platformBaseUrl` from the lockfile, if set. This is the value
 * persisted by {@link syncConfigToLockfile} the last time the active
 * assistant was hatched/waked, and is the source of truth for "which
 * platform does the currently-active assistant target".
 */
export function getLockfilePlatformBaseUrl(): string | undefined {
  const url = readLockfile().platformBaseUrl;
  if (typeof url === "string" && url.trim()) return url.trim();
  return undefined;
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
