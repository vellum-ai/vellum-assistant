/**
 * Identity and health endpoint handlers.
 */

import { existsSync, readFileSync } from "node:fs";
import { totalmem } from "node:os";

import { z } from "zod";

import { getIsPlatform } from "../../config/env-registry.js";
import { getDbMigrationReadiness } from "../../daemon/daemon-readiness.js";
import { parseIdentityFields } from "../../daemon/handlers/identity.js";
import { getProfilerRuntimeStatus } from "../../daemon/profiler-run-store.js";
import { getMaxRollbackVersion } from "../../persistence/migrations/run-migrations.js";
import { migrationSteps } from "../../persistence/steps.js";
import { getCesClient } from "../../security/secure-keys.js";
import { getContainerCpuCores } from "../../util/cgroup-cpu.js";
import {
  getContainerMemoryLimitBytes,
  getContainerMemoryUsageBytes,
} from "../../util/cgroup-memory.js";
import { getCachedContainerCpuPercent } from "../../util/container-cpu-sampler.js";
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

/**
 * Sample this process's resident set size (RSS) in bytes, returning `null` when
 * the reading fails.
 *
 * Bun 1.3.11 can throw `SystemError: Failed to get memory usage, errno: 2` from
 * the underlying getrusage syscall. The health payload is best-effort, so a
 * failed sample must never propagate and turn the liveness probe into a 500 —
 * fall back to `null` and let the caller substitute an alternative source.
 */
function sampleProcessRssBytes(): number | null {
  try {
    return process.memoryUsage().rss;
  } catch {
    return null;
  }
}

function getMemoryInfo(): MemoryInfo {
  // The health payload is best-effort: every resource read below can hit a
  // flaky syscall, so a failure must degrade to 0 rather than turn the health
  // endpoint into a 500.
  try {
    const bytesToMb = (b: number) =>
      Math.round((b / (1024 * 1024)) * 100) / 100;
    // In platform-managed mode the daemon shares its Node process with whatever
    // the container is doing as a whole; `process.memoryUsage().rss` only sees
    // this process's resident set, which understates the container footprint
    // operators care about. Read the cgroup usage file directly so /v1/health
    // matches what the StatefulSet's memory limit is enforced against. When RSS
    // can't be sampled, fall back to the cgroup usage (if any) before reporting 0
    // — the metric is best-effort and must never fail the probe.
    const currentBytes =
      (getIsPlatform() ? getContainerMemoryUsageBytes() : null) ??
      sampleProcessRssBytes() ??
      getContainerMemoryUsageBytes() ??
      0;
    return {
      currentMb: bytesToMb(currentBytes),
      maxMb: bytesToMb(getContainerMemoryLimitBytes() ?? sampleTotalMemBytes()),
    };
  } catch {
    return { currentMb: 0, maxMb: 0 };
  }
}

/** Total system memory in bytes, or 0 when the syscall fails. */
function sampleTotalMemBytes(): number {
  try {
    return totalmem();
  } catch {
    return 0;
  }
}

interface CpuInfo {
  currentPercent: number;
  maxCores: number;
}

function getCpuInfo(): CpuInfo {
  return {
    currentPercent: getCachedContainerCpuPercent(),
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

/** Disk usage for the health payload; null when it can't be measured. */
async function sampleDiskUsageInfo(): ReturnType<typeof getDiskUsageInfo> {
  try {
    return await getDiskUsageInfo();
  } catch {
    return null;
  }
}

async function getDetailedHealth() {
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
    disk: await sampleDiskUsageInfo(),
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
      retryLastTurn: true,
      appPins: true,
    },
    ...(profiler ? { profiler } : {}),
    ...migrationHealthFields,
  };
}

export async function handleDetailedHealth(): Promise<Response> {
  return Response.json(await getDetailedHealth());
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
  if (dbMigrations.ready) {
    return null;
  }

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

  if (!dbMigrations.ready) {
    // Probe contract: HTTP 200 keeps the k8s pod in service while migrations
    // run (the per-route gates shield the DB), but the body carries the real
    // state so programmatic callers — notably the CLI's readiness wait — can
    // distinguish "still migrating" from "ready". Only the status code is the
    // k8s contract; orchestrators never read the body.
    return Response.json(
      { status: "migrating", ready: false, dbMigrations },
      { status: 200 },
    );
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
  retryLastTurn: z.boolean(),
  appPins: z.boolean(),
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
