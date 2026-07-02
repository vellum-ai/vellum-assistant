/**
 * Identity and health endpoint handlers.
 */

import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, cpus, totalmem } from "node:os";

import { z } from "zod";

import { getCpuLimit, getIsPlatform } from "../../config/env-registry.js";
import { getDbMigrationReadiness } from "../../daemon/daemon-readiness.js";
import { parseIdentityFields } from "../../daemon/handlers/identity.js";
import { getProfilerRuntimeStatus } from "../../daemon/profiler-run-store.js";
import { getMaxRollbackVersion } from "../../persistence/migrations/run-migrations.js";
import { migrationSteps } from "../../persistence/steps.js";
import { getCesClient } from "../../security/secure-keys.js";
import {
  getContainerMemoryLimitBytes,
  getContainerMemoryUsageBytes,
} from "../../util/cgroup-memory.js";
import { getDiskUsageInfo } from "../../util/disk-usage.js";
import { getWorkspacePromptPath } from "../../util/platform.js";
import { APP_VERSION } from "../../version.js";
import { resolveHatchedAtReadOnly } from "../../workspace/hatched-date.js";
import { WORKSPACE_MIGRATIONS } from "../../workspace/migrations/registry.js";
import { getLastWorkspaceMigrationId } from "../../workspace/migrations/runner.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

interface MemoryInfo {
  currentMb: number;
  maxMb: number;
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

/**
 * Trivial liveness/startup probe (`GET /healthz`).
 *
 * This is the k8s startup + liveness probe target: it must answer the instant
 * the HTTP server is up and must NEVER touch DB, CES, migrations, or any other
 * lifecycle state. Keep it to a static `{ status, version }` payload — no
 * syscalls, no disk/memory/cpu reads, no async work.
 */
export function handleHealth(): Response {
  return Response.json({ status: "ok", version: APP_VERSION });
}

function getDetailedHealth() {
  let profiler: ReturnType<typeof getProfilerRuntimeStatus> | undefined;
  try {
    profiler = getProfilerRuntimeStatus();
  } catch {
    // Profiler status is non-critical — omit on error
  }

  const cesClient = getCesClient();
  const dbMigrations = getDbMigrationReadiness();
  const migrationHealthFields = dbMigrations.ready
    ? {}
    : {
        status: dbMigrations.state === "failed" ? "ERROR" : "MIGRATING",
        reason: dbMigrations.reason,
        dbMigrations,
      };

  return {
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
    disk: getDiskUsageInfo(),
    memory: getMemoryInfo(),
    cpu: getCpuInfo(),
    migrations: {
      dbVersion: getMaxRollbackVersion(migrationSteps),
      lastWorkspaceMigrationId:
        getLastWorkspaceMigrationId(WORKSPACE_MIGRATIONS),
    },
    ces: {
      connected: cesClient?.isReady() ?? false,
    },
    capabilities: {
      memoryOptOut: true,
    },
    ...(profiler ? { profiler } : {}),
    ...migrationHealthFields,
  };
}

export function handleDetailedHealth(): Response {
  return Response.json(getDetailedHealth());
}

type UnreadyDbMigrationReadiness = Extract<
  ReturnType<typeof getDbMigrationReadiness>,
  { ready: false }
>;

function dbMigrationUnavailableBody(dbMigrations: UnreadyDbMigrationReadiness) {
  return {
    status: dbMigrations.state === "failed" ? "error" : "starting",
    ready: false,
    reason: dbMigrations.reason,
    dbMigrations,
  };
}

export function dbMigrationUnavailableResponse(): Response | null {
  const dbMigrations = getDbMigrationReadiness();
  if (dbMigrations.ready) return null;

  return Response.json(dbMigrationUnavailableBody(dbMigrations), {
    status: 503,
  });
}

export function handleReadyz(): Response {
  const dbMigrations = getDbMigrationReadiness();
  if (dbMigrations.state === "failed") {
    return Response.json(dbMigrationUnavailableBody(dbMigrations), {
      status: 503,
    });
  }

  return Response.json({ status: "ok", ready: true });
}

function getIdentity() {
  const identityPath = getWorkspacePromptPath("IDENTITY.md");
  if (!existsSync(identityPath)) {
    throw new NotFoundError("IDENTITY.md not found");
  }

  const content = readFileSync(identityPath, "utf-8");
  const fields = parseIdentityFields(content);

  const version = APP_VERSION;

  const createdAt = resolveIdentityCreatedAt(identityPath);

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

function resolveIdentityCreatedAt(identityPath: string): string | undefined {
  return resolveHatchedAtReadOnly(identityPath);
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

const cesHealthSchema = z.object({
  connected: z.boolean(),
});

const healthCapabilitiesSchema = z.object({
  memoryOptOut: z.boolean(),
});

const healthDiskSchema = z.object({
  path: z.string(),
  totalMb: z.number(),
  usedMb: z.number(),
  freeMb: z.number(),
});

const healthMemorySchema = z.object({
  currentMb: z.number(),
  maxMb: z.number(),
});

const healthCpuSchema = z.object({
  currentPercent: z.number(),
  maxCores: z.number(),
});

const healthMigrationsSchema = z.object({
  dbVersion: z.number(),
  lastWorkspaceMigrationId: z.string().nullable(),
});

const dbMigrationReadinessSchema = z.object({
  ready: z.boolean(),
  state: z.enum(["not_started", "running", "failed", "ready"]),
  reason: z.string().optional(),
  error: z.string().optional(),
});

const detailedHealthSchema = z.object({
  status: z.string(),
  timestamp: z.string(),
  version: z.string(),
  // `getDiskUsageInfo()` returns null when usage can't be measured.
  disk: healthDiskSchema.nullable(),
  memory: healthMemorySchema,
  cpu: healthCpuSchema,
  migrations: healthMigrationsSchema,
  ces: cesHealthSchema,
  capabilities: healthCapabilitiesSchema,
  profiler: profilerStatusSchema.optional(),
  reason: z.string().optional(),
  dbMigrations: dbMigrationReadinessSchema.optional(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "health",
    endpoint: "health",
    method: "GET",
    policy: null,
    handler: getDetailedHealth,
    summary: "Detailed health check",
    description:
      "Returns runtime health including version, disk, memory, CPU, and migration status.",
    tags: ["system"],
    responseBody: detailedHealthSchema,
    // Clients (notably the macOS app) poll this every few seconds; the
    // first handful of 200s confirm the route works and every line after
    // is just noise. Non-2xx still logs.
    logging: { silenceSuccessAfter: 5 },
  },
  {
    operationId: "healthz",
    endpoint: "healthz",
    method: "GET",
    policy: null,
    handler: getDetailedHealth,
    summary: "Detailed health check (alias)",
    description:
      "Alias for /v1/health. Returns runtime health including version, disk, memory, CPU, and migration status.",
    tags: ["system"],
    responseBody: detailedHealthSchema,
    logging: { silenceSuccessAfter: 5 },
  },
  {
    operationId: "identity",
    endpoint: "identity",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
      createdAt: z.string().optional(),
    }),
  },
];
