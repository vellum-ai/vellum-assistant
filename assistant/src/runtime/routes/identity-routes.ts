/**
 * Identity and health endpoint handlers.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync, statSync } from "node:fs";
import { availableParallelism, cpus, totalmem } from "node:os";

import { z } from "zod";

import {
  getCpuLimit,
  getIsPlatform,
  getMinikubeStorageSize,
} from "../../config/env-registry.js";
import { parseIdentityFields } from "../../daemon/handlers/identity.js";
import { getProfilerRuntimeStatus } from "../../daemon/profiler-run-store.js";
import { getMaxMigrationVersion } from "../../memory/migrations/registry.js";
import {
  getWorkspaceDir,
  getWorkspacePromptPath,
} from "../../util/platform.js";
import { APP_VERSION } from "../../version.js";
import { WORKSPACE_MIGRATIONS } from "../../workspace/migrations/registry.js";
import { getLastWorkspaceMigrationId } from "../../workspace/migrations/runner.js";
import { NotFoundError } from "./errors.js";
import { getCachedIntro } from "./identity-intro-cache.js";
import type { RouteDefinition } from "./types.js";

interface DiskSpaceInfo {
  path: string;
  totalMb: number;
  usedMb: number;
  freeMb: number;
}

/**
 * Measure the on-disk usage of one or more directory paths using `du -sb`.
 * Returns the sum of all paths in bytes, or null on failure.
 */
function getDirectorySizeBytes(paths: string[]): number | null {
  try {
    const existing = paths.filter((p) => existsSync(p));
    if (existing.length === 0) return null;
    const result = spawnSync("du", ["-sb", ...existing], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    if (result.status !== 0) return null;
    let total = 0;
    for (const line of result.stdout.trim().split("\n")) {
      const size = parseInt(line.split("\t")[0], 10);
      if (!isNaN(size) && size > 0) total += size;
    }
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

const DU_CACHE_TTL_MS = 60_000;
let duCacheValue: number | null = null;
let duCacheTime = 0;
let duCachePaths: string | null = null;

function getCachedDirectorySizeBytes(paths: string[]): number | null {
  const key = paths.join("\0");
  const now = Date.now();
  if (duCachePaths === key && now - duCacheTime < DU_CACHE_TTL_MS) {
    return duCacheValue;
  }
  duCacheValue = getDirectorySizeBytes(paths);
  duCacheTime = now;
  duCachePaths = key;
  return duCacheValue;
}

function getDiskSpaceInfo(): DiskSpaceInfo | null {
  try {
    const wsDir = getWorkspaceDir();
    const diskPath = existsSync(wsDir) ? wsDir : "/";
    const stats = statfsSync(diskPath);
    const fsTotalBytes = stats.bsize * stats.blocks;
    const fsFreeBytes = stats.bsize * stats.bavail;
    const bytesToMb = (b: number) =>
      Math.round((b / (1024 * 1024)) * 100) / 100;

    // Minikube mode: the platform passes the PVC storage size so we can
    // report accurate capacity. On hostPath-backed PVCs statfsSync reports
    // the host's entire filesystem rather than the PVC. Detect this by
    // comparing filesystem size against PVC size — if the filesystem is
    // larger, measure actual directory usage with `du` instead.
    const storageSizeRaw = getMinikubeStorageSize();
    if (storageSizeRaw) {
      const pvcTotalBytes = parseK8sMemoryBytes(storageSizeRaw);
      if (pvcTotalBytes !== null && fsTotalBytes > pvcTotalBytes * 1.1) {
        const volumePaths = [diskPath];
        if (diskPath !== "/data" && existsSync("/data")) {
          volumePaths.push("/data");
        }
        const usedBytes = getCachedDirectorySizeBytes(volumePaths);
        if (usedBytes !== null) {
          return {
            path: diskPath,
            totalMb: bytesToMb(pvcTotalBytes),
            usedMb: bytesToMb(usedBytes),
            freeMb: bytesToMb(Math.max(0, pvcTotalBytes - usedBytes)),
          };
        }
      }
    }

    return {
      path: diskPath,
      totalMb: bytesToMb(fsTotalBytes),
      usedMb: bytesToMb(fsTotalBytes - fsFreeBytes),
      freeMb: bytesToMb(fsFreeBytes),
    };
  } catch {
    return null;
  }
}

interface MemoryInfo {
  currentMb: number;
  maxMb: number;
}

/**
 * Parse a Kubernetes-style memory string (e.g. "3Gi", "512Mi", "1G") into bytes.
 * Returns null if the value is not a recognized format.
 */
function parseK8sMemoryBytes(value: string): number | null {
  const match = value
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E|m)?$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = match[2] ?? "";
  const multipliers: Record<string, number> = {
    "": 1,
    m: 1e-3,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  };
  const mult = multipliers[unit];
  if (mult === undefined) return null;
  const bytes = Math.round(num * mult);
  return bytes > 0 ? bytes : null;
}

/**
 * Read the memory limit from the VELLUM_MEMORY_LIMIT env var (K8s resource format),
 * then fall back to cgroups, then to os.totalmem().
 *
 * In platform mode the container runs under gVisor where cgroup files may report
 * the node's memory rather than the container limit. VELLUM_MEMORY_LIMIT is set
 * by the StatefulSet template to the exact K8s memory limit (e.g. "3Gi").
 */
function getContainerMemoryLimitBytes(): number | null {
  // 1. Prefer the explicit env var set by the platform StatefulSet template.
  try {
    const envLimit = process.env.VELLUM_MEMORY_LIMIT;
    if (envLimit) {
      const parsed = parseK8sMemoryBytes(envLimit);
      if (parsed !== null) return parsed;
    }
  } catch {
    /* env var parsing failed – fall through to cgroups */
  }

  // 2. Try cgroups v2.
  try {
    const v2 = readFileSync("/sys/fs/cgroup/memory.max", "utf-8").trim();
    if (v2 !== "max") {
      const bytes = parseInt(v2, 10);
      if (!isNaN(bytes) && bytes > 0) return bytes;
    }
  } catch {
    /* not available */
  }

  // 3. Try cgroups v1.
  try {
    const v1 = readFileSync(
      "/sys/fs/cgroup/memory/memory.limit_in_bytes",
      "utf-8",
    ).trim();
    const bytes = parseInt(v1, 10);
    // cgroups v1 uses a near-INT64_MAX sentinel when no limit is set
    if (!isNaN(bytes) && bytes > 0 && bytes < totalmem() * 1.5) return bytes;
  } catch {
    /* not available */
  }
  return null;
}

/**
 * Read the container's current memory usage from cgroup files.
 *
 * Tries cgroups v2 (`memory.current`) first, then cgroups v1
 * (`memory/memory.usage_in_bytes`), mirroring the v2-then-v1 fallback used by
 * `getContainerMemoryLimitBytes`. Returns null if neither file is available
 * or readable.
 *
 * Unlike the limit lookup, no env-var override is needed: the gVisor issue
 * that motivates VELLUM_MEMORY_LIMIT is specifically about the *limit* files
 * exposing the host node's memory instead of the sandbox limit. The *usage*
 * files (memory.current / memory.usage_in_bytes) reflect the sandbox's own
 * accounting and are accurate under gVisor.
 */
function getContainerMemoryUsageBytes(): number | null {
  // 1. Try cgroups v2.
  try {
    const v2 = readFileSync("/sys/fs/cgroup/memory.current", "utf-8").trim();
    const bytes = parseInt(v2, 10);
    if (!isNaN(bytes) && bytes > 0) return bytes;
  } catch {
    /* not available */
  }

  // 2. Try cgroups v1.
  try {
    const v1 = readFileSync(
      "/sys/fs/cgroup/memory/memory.usage_in_bytes",
      "utf-8",
    ).trim();
    const bytes = parseInt(v1, 10);
    if (!isNaN(bytes) && bytes > 0) return bytes;
  } catch {
    /* not available */
  }
  return null;
}

function getMemoryInfo(): MemoryInfo {
  const bytesToMb = (b: number) => Math.round((b / (1024 * 1024)) * 100) / 100;
  // In platform-managed mode the daemon shares its Node process with whatever
  // the container is doing as a whole; `process.memoryUsage().rss` only sees
  // this process's resident set, which understates the container footprint
  // operators care about. Read the cgroup usage file directly so /v1/health
  // matches what the StatefulSet's memory limit is enforced against.
  const currentBytes =
    (getIsPlatform() ? getContainerMemoryUsageBytes() : null) ??
    process.memoryUsage().rss;
  return {
    currentMb: bytesToMb(currentBytes),
    maxMb: bytesToMb(getContainerMemoryLimitBytes() ?? totalmem()),
  };
}

interface CpuInfo {
  currentPercent: number;
  maxCores: number;
}

/**
 * Parse a Kubernetes-style CPU string (e.g. "2000m", "1", "500m") into
 * fractional cores. Returns null if the value is not a recognized format.
 */
function parseK8sCpuCores(value: string): number | null {
  const trimmed = value.trim();
  const milliMatch = trimmed.match(/^(\d+)m$/);
  if (milliMatch) {
    const millis = parseInt(milliMatch[1], 10);
    return millis > 0 ? millis / 1000 : null;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const num = parseFloat(trimmed);
    return !isNaN(num) && num > 0 ? num : null;
  }
  return null;
}

/**
 * Read the container's CPU core limit.
 *
 * Resolution order:
 * 1. VELLUM_CPU_LIMIT env var (K8s resource format, e.g. "2000m" or "2").
 *    In platform mode the container runs under gVisor where cgroup files may
 *    report the node's CPU count rather than the sandbox limit.
 * 2. cgroups v2 cpu.max (quota / period → fractional cores).
 * 3. cgroups v1 cpu.cfs_quota_us / cpu.cfs_period_us.
 * 4. os.cpus().length as last resort.
 */
function getContainerCpuCores(): number {
  // 1. Prefer the explicit env var set by the platform StatefulSet template.
  try {
    const envLimit = getCpuLimit();
    if (envLimit) {
      const parsed = parseK8sCpuCores(envLimit);
      if (parsed !== null) return parsed;
    }
  } catch {
    /* env var parsing failed – fall through */
  }

  // 2. Try cgroups v2: /sys/fs/cgroup/cpu.max contains "$MAX $PERIOD".
  try {
    const raw = readFileSync("/sys/fs/cgroup/cpu.max", "utf-8").trim();
    if (!raw.startsWith("max")) {
      const parts = raw.split(/\s+/);
      const quota = parseInt(parts[0], 10);
      const period = parseInt(parts[1], 10);
      if (!isNaN(quota) && !isNaN(period) && period > 0 && quota > 0) {
        const cores = quota / period;
        // Sanity check: if the value looks like the node's full CPU count
        // and we're on a platform pod, it's likely gVisor leaking the host value.
        if (cores < cpus().length * 0.9 || !getIsPlatform()) {
          return cores;
        }
      }
    }
  } catch {
    /* not available */
  }

  // 3. Try cgroups v1.
  try {
    const quota = parseInt(
      readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf-8").trim(),
      10,
    );
    const period = parseInt(
      readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf-8").trim(),
      10,
    );
    if (!isNaN(quota) && !isNaN(period) && period > 0 && quota > 0) {
      const cores = quota / period;
      if (cores < cpus().length * 0.9 || !getIsPlatform()) {
        return cores;
      }
    }
  } catch {
    /* not available */
  }

  return cpus().length || availableParallelism();
}

/**
 * Read the container's CPU usage from cgroup accounting files.
 *
 * Returns total CPU microseconds consumed by the container since boot.
 * We use the delta between two samples to compute percentage.
 */
function getContainerCpuUsageUs(): number | null {
  // cgroups v2: cpu.stat has a "usage_usec" line.
  try {
    const stat = readFileSync("/sys/fs/cgroup/cpu.stat", "utf-8");
    for (const line of stat.split("\n")) {
      if (line.startsWith("usage_usec")) {
        const val = parseInt(line.split(/\s+/)[1], 10);
        if (!isNaN(val) && val > 0) return val;
      }
    }
  } catch {
    /* not available */
  }

  // cgroups v1: cpuacct.usage is in nanoseconds.
  try {
    const ns = parseInt(
      readFileSync("/sys/fs/cgroup/cpuacct/cpuacct.usage", "utf-8").trim(),
      10,
    );
    if (!isNaN(ns) && ns > 0) return ns / 1000; // convert ns → µs
  } catch {
    /* not available */
  }

  return null;
}

// Track CPU usage over a rolling window so /v1/health reports near-real-time
// utilization instead of a lifetime average (total CPU time / total uptime).
const CPU_SAMPLE_INTERVAL_MS = 5_000;
let _lastProcessCpuUsage: NodeJS.CpuUsage = process.cpuUsage();
let _lastCgroupCpuUs: number | null = getContainerCpuUsageUs();
let _lastCpuTime: number = Date.now();
let _cachedCpuPercent = 0;

// Kick off the background sampler. unref() so it never prevents process exit.
setInterval(() => {
  const now = Date.now();
  const elapsedMs = now - _lastCpuTime;
  if (elapsedMs <= 0) return;

  const numCores = getContainerCpuCores();

  // Always sample process-level CPU so the baseline stays fresh. This
  // prevents a spike if the platform cgroup path later falls back to
  // process.cpuUsage() after cgroup stats were previously available.
  const newProcessUsage = process.cpuUsage();
  const processDeltaUs =
    newProcessUsage.user -
    _lastProcessCpuUsage.user +
    (newProcessUsage.system - _lastProcessCpuUsage.system);
  _lastProcessCpuUsage = newProcessUsage;

  if (getIsPlatform()) {
    // In platform mode, prefer cgroup-level CPU usage so we see the full
    // container footprint, not just this process.
    const cgroupUs = getContainerCpuUsageUs();
    if (cgroupUs !== null && _lastCgroupCpuUs !== null) {
      const deltaCpuUs = cgroupUs - _lastCgroupCpuUs;
      const deltaCpuMs = deltaCpuUs / 1000;
      _cachedCpuPercent =
        Math.round((deltaCpuMs / (elapsedMs * numCores)) * 10000) / 100;
    } else {
      // cgroup CPU stats unavailable (e.g. gVisor) – fall back to process-level.
      const deltaCpuMs = processDeltaUs / 1000;
      _cachedCpuPercent =
        Math.round((deltaCpuMs / (elapsedMs * numCores)) * 10000) / 100;
    }
    _lastCgroupCpuUs = cgroupUs;
  } else {
    // Non-platform: use process.cpuUsage() (accurate for single-process mode).
    const deltaCpuMs = processDeltaUs / 1000;
    _cachedCpuPercent =
      Math.round((deltaCpuMs / (elapsedMs * numCores)) * 10000) / 100;
  }

  _lastCpuTime = now;
}, CPU_SAMPLE_INTERVAL_MS).unref();

function getCpuInfo(): CpuInfo {
  return {
    currentPercent: _cachedCpuPercent,
    maxCores: Math.ceil(getContainerCpuCores()),
  };
}

export function handleHealth(): Response {
  return Response.json({ status: "ok" });
}

function getDetailedHealth() {
  let profiler: ReturnType<typeof getProfilerRuntimeStatus> | undefined;
  try {
    profiler = getProfilerRuntimeStatus();
  } catch {
    // Profiler status is non-critical — omit on error
  }

  return {
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
    disk: getDiskSpaceInfo(),
    memory: getMemoryInfo(),
    cpu: getCpuInfo(),
    migrations: {
      dbVersion: getMaxMigrationVersion(),
      lastWorkspaceMigrationId:
        getLastWorkspaceMigrationId(WORKSPACE_MIGRATIONS),
    },
    ...(profiler ? { profiler } : {}),
  };
}

export function handleDetailedHealth(): Response {
  return Response.json(getDetailedHealth());
}

export function handleReadyz(): Response {
  return Response.json({ status: "ok" });
}

function getIdentity() {
  const identityPath = getWorkspacePromptPath("IDENTITY.md");
  if (!existsSync(identityPath)) {
    throw new NotFoundError("IDENTITY.md not found");
  }

  const content = readFileSync(identityPath, "utf-8");
  const fields = parseIdentityFields(content);

  const version = APP_VERSION;

  let createdAt: string | undefined;
  try {
    const stats = statSync(identityPath);
    createdAt = stats.birthtime.toISOString();
  } catch {
    // ignore
  }

  return {
    name: fields.name ?? "",
    role: fields.role ?? "",
    personality: fields.personality ?? "",
    emoji: fields.emoji ?? "",
    home: fields.home ?? "",
    version,
    createdAt,
  };
}

function getIdentityIntro() {
  const identityPath = getWorkspacePromptPath("IDENTITY.md");
  if (existsSync(identityPath)) {
    const content = readFileSync(identityPath, "utf-8");
    const fields = parseIdentityFields(content);
    if (fields.name) {
      return { text: `Hi, I'm ${fields.name}!` };
    }
  }

  const cached = getCachedIntro();
  if (!cached) {
    throw new NotFoundError("No cached identity intro available");
  }
  return { text: cached.text };
}

// ---------------------------------------------------------------------------
// Zod schemas for profiler health metadata
// ---------------------------------------------------------------------------

const profilerBudgetSchema = z.object({
  maxBytes: z.number(),
  remainingBytes: z.number(),
  minFreeMb: z.number(),
  freeMb: z.number(),
  overBudget: z.boolean(),
});

const profilerLastCompletedRunSchema = z.object({
  runId: z.string(),
  totalBytes: z.number(),
  artifactCount: z.number(),
  hasSummaries: z.boolean(),
  completedAt: z.string(),
});

const profilerStatusSchema = z.object({
  enabled: z.boolean(),
  mode: z.string().nullable(),
  runId: z.string().nullable(),
  runDir: z.string().nullable(),
  totalBytes: z.number(),
  artifactCount: z.number(),
  budget: profilerBudgetSchema.nullable(),
  lastCompletedRun: profilerLastCompletedRunSchema.nullable(),
});

const detailedHealthSchema = z.object({
  status: z.string(),
  timestamp: z.string(),
  version: z.string(),
  disk: z.object({}).passthrough(),
  memory: z.object({}).passthrough(),
  cpu: z.object({}).passthrough(),
  migrations: z.object({}).passthrough(),
  profiler: profilerStatusSchema.optional(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "health",
    endpoint: "health",
    method: "GET",
    handler: getDetailedHealth,
    summary: "Detailed health check",
    description:
      "Returns runtime health including version, disk, memory, CPU, and migration status.",
    tags: ["system"],
    responseBody: detailedHealthSchema,
  },
  {
    operationId: "healthz",
    endpoint: "healthz",
    method: "GET",
    handler: getDetailedHealth,
    policyKey: "health",
    summary: "Detailed health check (alias)",
    description:
      "Alias for /v1/health. Returns runtime health including version, disk, memory, CPU, and migration status.",
    tags: ["system"],
    responseBody: detailedHealthSchema,
  },
  {
    operationId: "identity",
    endpoint: "identity",
    method: "GET",
    handler: getIdentity,
    summary: "Get assistant identity",
    description:
      "Returns the assistant's identity fields parsed from IDENTITY.md.",
    tags: ["identity"],
    responseBody: z.object({
      name: z.string(),
      role: z.string(),
      personality: z.string(),
      emoji: z.string(),
      home: z.string(),
      version: z.string(),
      createdAt: z.string(),
    }),
  },
  {
    operationId: "identity_intro",
    endpoint: "identity/intro",
    method: "GET",
    handler: getIdentityIntro,
    summary: "Get identity intro text",
    description:
      "Returns a deterministic greeting derived from the assistant name in IDENTITY.md, falling back to LLM-generated cache.",
    tags: ["identity"],
    responseBody: z.object({
      text: z.string(),
    }),
  },
];
