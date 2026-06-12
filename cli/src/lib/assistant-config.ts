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

import { SEEDS, type EnvironmentDefinition } from "@vellumai/environments";

import { DAEMON_INTERNAL_ASSISTANT_ID } from "./constants.js";
import {
  getDefaultPorts,
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
  /** Platform-provided display name, when available. */
  name?: string;
  /** Older lockfile key for the display name, if present. */
  assistantName?: string;
  runtimeUrl: string;
  /** Loopback URL for same-machine health checks (e.g. `http://127.0.0.1:7831`).
   *  Avoids mDNS resolution issues when the machine checks its own gateway. */
  localUrl?: string;
  bearerToken?: string;
  /** Deployment topology / how the assistant is reached. Known values:
   *  `"local"` (on-machine daemon), `"docker"` (local container),
   *  `"apple-container"` (macOS-app-managed container), `"vellum"`
   *  (platform-managed, uses the X-Session-Token auth path), `"gcp"` / `"aws"`
   *  / `"custom"` (remote, SSH-managed), and `"paired"` (a remote assistant
   *  paired from another machine — reached via a bearer guardian token at
   *  `runtimeUrl`; has no local process, container, or `resources`).
   *  Kept as a free `string` (not a union) for forward-compatibility. */
  cloud: string;
  /** True when this entry was registered via `vellum connect import` (a remote
   *  pairing). Set alongside `cloud: "paired"`; also backs the re-import /
   *  overwrite guard in connect import. */
  paired?: boolean;
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
  /** Local bootstrap secret used to lease guardian tokens for Docker assistants after detached hatch. */
  guardianBootstrapSecret?: string;
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

export type AssistantLookupResult =
  | { status: "found"; entry: AssistantEntry }
  | { status: "not_found" }
  | { status: "ambiguous"; matches: AssistantEntry[] };

interface LockfileData {
  assistants?: Record<string, unknown>[];
  activeAssistant?: string;
  platformBaseUrl?: string;
  [key: string]: unknown;
}

/**
 * Derive the daemon PID file path from a resources object. The PID file
 * lives inside the instance's workspace directory. When no resources are
 * available, falls back to `~/.vellum/workspace/vellum.pid`.
 */
export function getDaemonPidPath(resources?: LocalInstanceResources): string {
  const vellumDir = resources
    ? join(resources.instanceDir, ".vellum")
    : join(homedir(), ".vellum");
  return join(vellumDir, "workspace", "vellum.pid");
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
  const defaultPorts = getDefaultPorts(env);
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
      parsePortFromUrl(raw.runtimeUrl) ?? defaultPorts.gateway;
    const instanceDir = join(
      getMultiInstanceDir(env),
      typeof raw.assistantId === "string"
        ? raw.assistantId
        : DAEMON_INTERNAL_ASSISTANT_ID,
    );
    raw.resources = {
      instanceDir,
      daemonPort: defaultPorts.daemon,
      gatewayPort,
      qdrantPort: defaultPorts.qdrant,
      cesPort: defaultPorts.ces,
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
      res.daemonPort = defaultPorts.daemon;
      mutated = true;
    }
    if (typeof res.gatewayPort !== "number") {
      res.gatewayPort =
        parsePortFromUrl(raw.runtimeUrl) ?? defaultPorts.gateway;
      mutated = true;
    }
    if (typeof res.qdrantPort !== "number") {
      res.qdrantPort = defaultPorts.qdrant;
      mutated = true;
    }
    if (typeof res.cesPort !== "number") {
      res.cesPort = defaultPorts.ces;
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
  return readAssistants().find((entry) => entry.assistantId === name) ?? null;
}

export function getAssistantDisplayName(entry: AssistantEntry): string {
  const primary = entry.name?.trim();
  if (primary) return primary;

  const legacy = entry.assistantName?.trim();
  if (legacy) return legacy;

  return entry.assistantId;
}

export function formatAssistantReference(entry: AssistantEntry): string {
  const displayName = getAssistantDisplayName(entry);
  return displayName === entry.assistantId
    ? entry.assistantId
    : `${displayName} (${entry.assistantId})`;
}

function getAssistantDisplayNameCandidates(entry: AssistantEntry): string[] {
  return Array.from(
    new Set(
      [entry.name?.trim(), entry.assistantName?.trim()].filter(
        (value): value is string => typeof value === "string" && value !== "",
      ),
    ),
  );
}

export function lookupAssistantByIdentifier(
  identifier: string,
): AssistantLookupResult {
  const entries = readAssistants();
  const exactId = entries.find((entry) => entry.assistantId === identifier);
  if (exactId) {
    return { status: "found", entry: exactId };
  }

  const displayMatches = entries.filter((entry) =>
    getAssistantDisplayNameCandidates(entry).includes(identifier),
  );
  if (displayMatches.length === 1) {
    return { status: "found", entry: displayMatches[0] };
  }
  if (displayMatches.length > 1) {
    return { status: "ambiguous", matches: displayMatches };
  }

  return { status: "not_found" };
}

export function formatAssistantLookupError(
  identifier: string,
  result: AssistantLookupResult = lookupAssistantByIdentifier(identifier),
): string {
  if (result.status === "ambiguous") {
    const matches = result.matches
      .map((entry) => formatAssistantReference(entry))
      .join(", ");
    return `Multiple assistants match '${identifier}': ${matches}. Use the assistant ID to disambiguate.`;
  }

  return `No assistant found with name or ID '${identifier}'.`;
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

/**
 * Read the first existing lockfile for an explicitly-provided environment,
 * without applying legacy migrations. This is the cross-env read path used by
 * {@link loadAllAssistantsAcrossEnvs}: it deliberately bypasses
 * {@link readLockfile} (which always resolves the *current* env) so callers
 * can enumerate state from every env without flipping `process.env` or the
 * persisted default. Migrations are skipped because we never want to write
 * to another env's lockfile from the current env's process.
 */
function readLockfileForEnv(env: EnvironmentDefinition): LockfileData {
  for (const lockfilePath of getLockfilePaths(env)) {
    if (!existsSync(lockfilePath)) continue;
    try {
      const raw = readFileSync(lockfilePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as LockfileData;
      }
    } catch {
      // Malformed; try next candidate
    }
  }
  return {};
}

/**
 * Load assistant entries from every known environment's lockfile.
 *
 * Each {@link SEEDS} entry has its own on-host data layout (config dir,
 * lockfile path, data dir). A running assistant from `dev` is invisible to
 * `loadAllAssistants()` when the current env is `local`, but its host
 * processes (daemon/gateway/qdrant) still show up in `ps ax`. The orphan
 * detector and `vellum clean` need the union of all envs' entries to avoid
 * misclassifying — or worse, killing — another env's running services.
 *
 * Optional `envs` override is provided for testability so call sites can
 * inject a curated env list with `lockfileDirOverride` set, without having
 * to manipulate the global SEEDS table or process.env.
 */
export function loadAllAssistantsAcrossEnvs(
  envs?: EnvironmentDefinition[],
): AssistantEntry[] {
  const envList = envs ?? Object.values(SEEDS).map((env) => ({ ...env }));
  const all: AssistantEntry[] = [];
  for (const env of envList) {
    const data = readLockfileForEnv(env);
    const entries = data.assistants;
    if (!Array.isArray(entries)) continue;
    for (const raw of entries) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as AssistantEntry;
      if (
        typeof entry.assistantId !== "string" ||
        typeof entry.runtimeUrl !== "string"
      ) {
        continue;
      }
      all.push(entry);
    }
  }
  return all;
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
 * Best-effort resolution of the target assistant. Returns null when no
 * match is found — callers decide how to handle the absence.
 *
 * Priority:
 * 1. Explicit name argument
 * 2. Active assistant set via `vellum use`
 * 3. Sole lockfile entry (any cloud)
 */
export function resolveAssistant(nameArg?: string): AssistantEntry | null {
  if (nameArg) {
    return findAssistantByName(nameArg);
  }

  const active = getActiveAssistant();
  if (active) {
    const entry = findAssistantByName(active);
    if (entry) return entry;
    // Active assistant no longer exists in lockfile — fall through
  }

  const all = readAssistants();
  if (all.length === 1) return all[0];

  return null;
}

/**
 * Resolve which assistant to target for a command, exiting the process
 * with a user-facing error when resolution fails.
 *
 * Priority:
 * 1. Explicit name argument
 * 2. Active assistant set via `vellum use`
 * 3. Sole lockfile entry (any cloud)
 */
export function resolveTargetAssistant(nameArg?: string): AssistantEntry {
  if (nameArg) {
    const result = lookupAssistantByIdentifier(nameArg);
    if (result.status === "found") return result.entry;
    console.error(formatAssistantLookupError(nameArg, result));
  } else {
    const active = getActiveAssistant();
    if (active) {
      const result = lookupAssistantByIdentifier(active);
      if (result.status === "found") return result.entry;
      if (result.status === "ambiguous") {
        console.error(formatAssistantLookupError(active, result));
        process.exit(1);
      }
      // Active assistant no longer exists in lockfile — fall through.
    }

    const all = readAssistants();
    if (all.length === 1) return all[0];

    if (all.length === 0) {
      console.error("No assistant found. Run 'vellum hatch' first.");
    } else {
      console.error(
        `Multiple assistants found. Set an active assistant with 'vellum use <name>'.`,
      );
    }
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

/**
 * Extract the hostname from a URL string. Falls back to stripping the scheme
 * and taking the hostname portion if URL parsing fails.
 */
export function extractHostFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return url.replace(/^https?:\/\//, "").split(":")[0];
  }
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

  // Env-aware bases: non-prod envs sit in their own 1000-port window so
  // running prod and staging assistants side-by-side doesn't collide. See
  // the `@vellumai/environments` `portBlock` layout.
  const basePorts = getDefaultPorts(env);
  const daemonPort = await findAvailablePort(basePorts.daemon, reservedPorts);
  const gatewayPort = await findAvailablePort(basePorts.gateway, [
    ...reservedPorts,
    daemonPort,
  ]);
  const qdrantPort = await findAvailablePort(basePorts.qdrant, [
    ...reservedPorts,
    daemonPort,
    gatewayPort,
  ]);
  const cesPort = await findAvailablePort(basePorts.ces, [
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
