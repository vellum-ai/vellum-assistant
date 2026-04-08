/**
 * Identity and health endpoint handlers.
 */

import { existsSync, readFileSync, statfsSync, statSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { heapStats } from "bun:jsc";

import { z } from "zod";

import { parseIdentityFields } from "../../daemon/handlers/identity.js";
import { getProfilerRuntimeStatus } from "../../daemon/profiler-run-store.js";
import { getMaxMigrationVersion } from "../../memory/migrations/registry.js";
import {
  getWorkspaceDir,
  getWorkspacePromptPath,
} from "../../util/platform.js";
import { WORKSPACE_MIGRATIONS } from "../../workspace/migrations/registry.js";
import { getLastWorkspaceMigrationId } from "../../workspace/migrations/runner.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import { getCachedIntro } from "./identity-intro-cache.js";

interface DiskSpaceInfo {
  path: string;
  totalMb: number;
  usedMb: number;
  freeMb: number;
}

function getDiskSpaceInfo(): DiskSpaceInfo | null {
  try {
    const wsDir = getWorkspaceDir();
    const diskPath = existsSync(wsDir) ? wsDir : "/";
    const stats = statfsSync(diskPath);
    const totalBytes = stats.bsize * stats.blocks;
    const freeBytes = stats.bsize * stats.bavail;
    const bytesToMb = (b: number) =>
      Math.round((b / (1024 * 1024)) * 100) / 100;
    return {
      path: diskPath,
      totalMb: bytesToMb(totalBytes),
      usedMb: bytesToMb(totalBytes - freeBytes),
      freeMb: bytesToMb(freeBytes),
    };
  } catch {
    return null;
  }
}

interface MemoryInfo {
  currentMb: number;
  maxMb: number;
  process: ProcessMemoryInfo;
  jsc: JscMemoryInfo | null;
  peaks: MemoryPeakInfo;
}

interface ProcessMemoryInfo {
  rssMb: number;
  heapTotalMb: number;
  heapUsedMb: number;
  externalMb: number;
  arrayBuffersMb: number;
}

interface JscMemoryInfo {
  heapSizeMb: number;
  heapCapacityMb: number;
  extraMemorySizeMb: number;
  objectCount: number;
  protectedObjectCount: number;
  globalObjectCount: number;
  protectedGlobalObjectCount: number;
}

interface MemoryPeakInfo {
  rssMb: number;
  heapUsedMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  jscHeapSizeMb: number | null;
  jscExtraMemorySizeMb: number | null;
}

interface MemorySnapshot {
  process: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  jsc: {
    heapSizeBytes: number;
    heapCapacityBytes: number;
    extraMemorySizeBytes: number;
    objectCount: number;
    protectedObjectCount: number;
    globalObjectCount: number;
    protectedGlobalObjectCount: number;
  } | null;
}

interface MemoryPeakSnapshot {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  jscHeapSizeBytes: number | null;
  jscExtraMemorySizeBytes: number | null;
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

function bytesToMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

function captureMemorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage();

  let jsc: MemorySnapshot["jsc"] = null;
  try {
    const stats = heapStats();
    jsc = {
      heapSizeBytes: stats.heapSize,
      heapCapacityBytes: stats.heapCapacity,
      extraMemorySizeBytes: stats.extraMemorySize,
      objectCount: stats.objectCount,
      protectedObjectCount: stats.protectedObjectCount,
      globalObjectCount: stats.globalObjectCount,
      protectedGlobalObjectCount: stats.protectedGlobalObjectCount,
    };
  } catch {
    jsc = null;
  }

  return {
    process: {
      rssBytes: usage.rss,
      heapTotalBytes: usage.heapTotal,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers,
    },
    jsc,
  };
}

let _memoryPeaks: MemoryPeakSnapshot = {
  rssBytes: 0,
  heapUsedBytes: 0,
  externalBytes: 0,
  arrayBuffersBytes: 0,
  jscHeapSizeBytes: null,
  jscExtraMemorySizeBytes: null,
};

function updateMemoryPeaks(snapshot: MemorySnapshot): void {
  _memoryPeaks = {
    rssBytes: Math.max(_memoryPeaks.rssBytes, snapshot.process.rssBytes),
    heapUsedBytes: Math.max(
      _memoryPeaks.heapUsedBytes,
      snapshot.process.heapUsedBytes,
    ),
    externalBytes: Math.max(
      _memoryPeaks.externalBytes,
      snapshot.process.externalBytes,
    ),
    arrayBuffersBytes: Math.max(
      _memoryPeaks.arrayBuffersBytes,
      snapshot.process.arrayBuffersBytes,
    ),
    jscHeapSizeBytes:
      snapshot.jsc === null
        ? _memoryPeaks.jscHeapSizeBytes
        : Math.max(
            _memoryPeaks.jscHeapSizeBytes ?? 0,
            snapshot.jsc.heapSizeBytes,
          ),
    jscExtraMemorySizeBytes:
      snapshot.jsc === null
        ? _memoryPeaks.jscExtraMemorySizeBytes
        : Math.max(
            _memoryPeaks.jscExtraMemorySizeBytes ?? 0,
            snapshot.jsc.extraMemorySizeBytes,
          ),
  };
}

function getMemoryInfo(): MemoryInfo {
  const snapshot = captureMemorySnapshot();
  updateMemoryPeaks(snapshot);

  return {
    currentMb: bytesToMb(snapshot.process.rssBytes),
    maxMb: bytesToMb(getContainerMemoryLimitBytes() ?? totalmem()),
    process: {
      rssMb: bytesToMb(snapshot.process.rssBytes),
      heapTotalMb: bytesToMb(snapshot.process.heapTotalBytes),
      heapUsedMb: bytesToMb(snapshot.process.heapUsedBytes),
      externalMb: bytesToMb(snapshot.process.externalBytes),
      arrayBuffersMb: bytesToMb(snapshot.process.arrayBuffersBytes),
    },
    jsc:
      snapshot.jsc === null
        ? null
        : {
            heapSizeMb: bytesToMb(snapshot.jsc.heapSizeBytes),
            heapCapacityMb: bytesToMb(snapshot.jsc.heapCapacityBytes),
            extraMemorySizeMb: bytesToMb(snapshot.jsc.extraMemorySizeBytes),
            objectCount: snapshot.jsc.objectCount,
            protectedObjectCount: snapshot.jsc.protectedObjectCount,
            globalObjectCount: snapshot.jsc.globalObjectCount,
            protectedGlobalObjectCount: snapshot.jsc.protectedGlobalObjectCount,
          },
    peaks: {
      rssMb: bytesToMb(_memoryPeaks.rssBytes),
      heapUsedMb: bytesToMb(_memoryPeaks.heapUsedBytes),
      externalMb: bytesToMb(_memoryPeaks.externalBytes),
      arrayBuffersMb: bytesToMb(_memoryPeaks.arrayBuffersBytes),
      jscHeapSizeMb:
        _memoryPeaks.jscHeapSizeBytes === null
          ? null
          : bytesToMb(_memoryPeaks.jscHeapSizeBytes),
      jscExtraMemorySizeMb:
        _memoryPeaks.jscExtraMemorySizeBytes === null
          ? null
          : bytesToMb(_memoryPeaks.jscExtraMemorySizeBytes),
    },
  };
}

interface CpuInfo {
  currentPercent: number;
  maxCores: number;
}

// Track CPU usage over a rolling window so /v1/health reports near-real-time
// utilization instead of a lifetime average (total CPU time / total uptime).
const CPU_SAMPLE_INTERVAL_MS = 5_000;
let _lastCpuUsage: NodeJS.CpuUsage = process.cpuUsage();
let _lastCpuTime: number = Date.now();
let _cachedCpuPercent = 0;

// Kick off the background sampler. unref() so it never prevents process exit.
setInterval(() => {
  const now = Date.now();
  const newUsage = process.cpuUsage();
  const elapsedMs = now - _lastCpuTime;
  if (elapsedMs > 0) {
    const deltaCpuUs =
      newUsage.user -
      _lastCpuUsage.user +
      (newUsage.system - _lastCpuUsage.system);
    const deltaCpuMs = deltaCpuUs / 1000;
    const numCores = cpus().length;
    _cachedCpuPercent =
      Math.round((deltaCpuMs / (elapsedMs * numCores)) * 10000) / 100;
  }
  _lastCpuUsage = newUsage;
  _lastCpuTime = now;
  updateMemoryPeaks(captureMemorySnapshot());
}, CPU_SAMPLE_INTERVAL_MS).unref();

function getCpuInfo(): CpuInfo {
  return {
    currentPercent: _cachedCpuPercent,
    maxCores: cpus().length,
  };
}

function getPackageVersion(): string | undefined {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version;
  } catch {
    return undefined;
  }
}

export function handleHealth(): Response {
  return Response.json({ status: "ok" });
}

export function handleDetailedHealth(): Response {
  let profiler: ReturnType<typeof getProfilerRuntimeStatus> | undefined;
  try {
    profiler = getProfilerRuntimeStatus();
  } catch {
    // Profiler status is non-critical — omit on error
  }

  return Response.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: getPackageVersion(),
    disk: getDiskSpaceInfo(),
    memory: getMemoryInfo(),
    cpu: getCpuInfo(),
    migrations: {
      dbVersion: getMaxMigrationVersion(),
      lastWorkspaceMigrationId:
        getLastWorkspaceMigrationId(WORKSPACE_MIGRATIONS),
    },
    ...(profiler ? { profiler } : {}),
  });
}

export function handleReadyz(): Response {
  return Response.json({ status: "ok" });
}

export function handleGetIdentity(): Response {
  const identityPath = getWorkspacePromptPath("IDENTITY.md");
  if (!existsSync(identityPath)) {
    return httpError("NOT_FOUND", "IDENTITY.md not found", 404);
  }

  const content = readFileSync(identityPath, "utf-8");
  const fields = parseIdentityFields(content);

  const version = getPackageVersion();

  // Read createdAt from IDENTITY.md file birthtime
  let createdAt: string | undefined;
  try {
    const stats = statSync(identityPath);
    createdAt = stats.birthtime.toISOString();
  } catch {
    // ignore
  }

  return Response.json({
    name: fields.name ?? "",
    role: fields.role ?? "",
    personality: fields.personality ?? "",
    emoji: fields.emoji ?? "",
    home: fields.home ?? "",
    version,
    createdAt,
  });
}

// ---------------------------------------------------------------------------
// Identity intro cache
// ---------------------------------------------------------------------------

/**
 * Parse the `## Identity Intro` section from SOUL.md.
 * Returns the first non-empty line under that heading, or null.
 */
function readSoulIdentityIntro(): string | null {
  try {
    const soulPath = getWorkspacePromptPath("SOUL.md");
    if (!existsSync(soulPath)) return null;
    const content = readFileSync(soulPath, "utf-8");

    let inSection = false;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (/^#+\s/.test(trimmed)) {
        inSection = trimmed.toLowerCase().includes("identity intro");
        continue;
      }
      if (inSection && trimmed.length > 0) {
        return trimmed;
      }
    }
  } catch {
    // Fall through to cache/fallback
  }
  return null;
}

export function handleGetIdentityIntro(): Response {
  // Prefer SOUL.md persisted intro over LLM-generated cache
  const soulIntro = readSoulIdentityIntro();
  if (soulIntro) {
    return Response.json({ text: soulIntro });
  }

  const cached = getCachedIntro();
  if (!cached) {
    return httpError("NOT_FOUND", "No cached identity intro available", 404);
  }
  return Response.json({ text: cached.text });
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

const processMemorySchema = z.object({
  rssMb: z.number(),
  heapTotalMb: z.number(),
  heapUsedMb: z.number(),
  externalMb: z.number(),
  arrayBuffersMb: z.number(),
});

const jscMemorySchema = z.object({
  heapSizeMb: z.number(),
  heapCapacityMb: z.number(),
  extraMemorySizeMb: z.number(),
  objectCount: z.number(),
  protectedObjectCount: z.number(),
  globalObjectCount: z.number(),
  protectedGlobalObjectCount: z.number(),
});

const memoryPeakSchema = z.object({
  rssMb: z.number(),
  heapUsedMb: z.number(),
  externalMb: z.number(),
  arrayBuffersMb: z.number(),
  jscHeapSizeMb: z.number().nullable(),
  jscExtraMemorySizeMb: z.number().nullable(),
});

const memoryInfoSchema = z.object({
  currentMb: z.number(),
  maxMb: z.number(),
  process: processMemorySchema,
  jsc: jscMemorySchema.nullable(),
  peaks: memoryPeakSchema,
});

const detailedHealthSchema = z.object({
  status: z.string(),
  timestamp: z.string(),
  version: z.string(),
  disk: z.object({}).passthrough(),
  memory: memoryInfoSchema,
  cpu: z.object({}).passthrough(),
  migrations: z.object({}).passthrough(),
  profiler: profilerStatusSchema.optional(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function identityRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "health",
      method: "GET",
      handler: () => handleDetailedHealth(),
      summary: "Detailed health check",
      description:
        "Returns runtime health including version, disk, memory, CPU, and migration status.",
      tags: ["system"],
      responseBody: detailedHealthSchema,
    },
    {
      endpoint: "healthz",
      method: "GET",
      handler: () => handleDetailedHealth(),
      policyKey: "health",
      summary: "Detailed health check (alias)",
      description:
        "Alias for /v1/health. Returns runtime health including version, disk, memory, CPU, and migration status.",
      tags: ["system"],
      responseBody: detailedHealthSchema,
    },
    {
      endpoint: "identity",
      method: "GET",
      handler: () => handleGetIdentity(),
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
      endpoint: "identity/intro",
      method: "GET",
      handler: () => handleGetIdentityIntro(),
      summary: "Get identity intro text",
      description:
        "Returns the cached identity intro string, preferring SOUL.md over LLM-generated cache.",
      tags: ["identity"],
      responseBody: z.object({
        text: z.string(),
      }),
    },
  ];
}
