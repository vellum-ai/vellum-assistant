/**
 * Identity and health endpoint handlers.
 */

import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, cpus, totalmem } from "node:os";

import { z } from "zod";

import { getCpuLimit, getIsPlatform } from "../../config/env-registry.js";
import { resolveCallSiteConfig } from "../../config/llm-resolver.js";
import { getConfig } from "../../config/loader.js";
import { parseIdentityFields } from "../../daemon/handlers/identity.js";
import { getProfilerRuntimeStatus } from "../../daemon/profiler-run-store.js";
import { getMaxMigrationVersion } from "../../memory/migrations/registry.js";
import { buildSystemPrompt } from "../../prompts/system-prompt.js";
import { getConfiguredProvider } from "../../providers/provider-send-message.js";
import { getCesClient } from "../../security/secure-keys.js";
import {
  getDiskUsageInfo,
  parseK8sMemoryBytes,
} from "../../util/disk-usage.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspacePromptPath } from "../../util/platform.js";
import { APP_VERSION } from "../../version.js";
import { resolveHatchedAtReadOnly } from "../../workspace/hatched-date.js";
import { WORKSPACE_MIGRATIONS } from "../../workspace/migrations/registry.js";
import { getLastWorkspaceMigrationId } from "../../workspace/migrations/runner.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { runBtwSidechain } from "../btw-sidechain.js";
import { NotFoundError } from "./errors.js";
import {
  getCachedIntro,
  readWorkspaceGreetings,
  readWorkspaceIdentityIntro,
  setCachedIntro,
} from "./identity-intro-cache.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

interface MemoryInfo {
  currentMb: number;
  maxMb: number;
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

  const cesClient = getCesClient();

  return {
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
    disk: getDiskUsageInfo(),
    memory: getMemoryInfo(),
    cpu: getCpuInfo(),
    migrations: {
      dbVersion: getMaxMigrationVersion(),
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
  };
}

export function handleDetailedHealth(): Response {
  return Response.json(getDetailedHealth());
}

export function handleReadyz(): Response {
  const cesClient = getCesClient();
  if (!cesClient?.isReady()) {
    // TODO: Return 503 once we confirm via logs that this won't cause
    // regressions in the K8s readinessProbe.
    getLogger("health").warn(
      { reason: cesClient ? "ces_not_ready" : "ces_unavailable" },
      "CES not ready — pod would be unready if 503 were enabled",
    );
  }
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

const FALLBACK_GREETINGS = [
  "What are we working on?",
  "I'm here whenever you need me.",
  "What's on your mind?",
  "Ready when you are.",
];

const GENERATED_GREETING_LIMIT = 5;
const GREETING_GENERATION_TIMEOUT_MS = 10_000;
const GREETING_GENERATION_FAILURE_COOLDOWN_MS = 60_000;
const EMPTY_STATE_GREETING_CALLSITE = "emptyStateGreeting" as const;
const EXPLICIT_TIME_OF_DAY_PATTERN =
  /\b(?:morning|afternoon|evening|tonight|midnight|noon|sunrise|sunset)\b/i;

type IdentityIntroSource = "workspace" | "cache" | "fallback";

interface IdentityIntroResponse {
  greetings: string[];
  text: string;
  source: IdentityIntroSource;
  refreshing: boolean;
}

let greetingGenerationInFlight: Promise<void> | null = null;
let lastGreetingGenerationFailureAt = 0;

function identityIntroResponse(
  greetings: string[],
  source: IdentityIntroSource,
  refreshing = false,
): IdentityIntroResponse {
  return {
    greetings,
    text: greetings[0] ?? "",
    source,
    refreshing,
  };
}

function getIdentityIntro({
  queryParams = {},
}: RouteHandlerArgs = {}): IdentityIntroResponse {
  const localTimeContext = buildLocalTimeContext(queryParams);

  // 1. User-defined greetings from SOUL.md `## Greetings`
  const workspaceGreetings = readWorkspaceGreetings();
  if (workspaceGreetings) {
    return identityIntroResponse(workspaceGreetings, "workspace");
  }

  // 2. Cached LLM-generated greetings
  const cached = getCachedIntro();
  if (cached) {
    return identityIntroResponse(cached.greetings, "cache");
  }

  // 3. Identity intro tagline from `## Identity Intro` in IDENTITY.md
  //    (written during onboarding by BOOTSTRAP.md instructions)
  const identityIntro = readWorkspaceIdentityIntro();
  if (identityIntro) {
    // Still trigger background generation so the next request gets
    // LLM-generated greetings instead of the static tagline.
    const refreshing = triggerEmptyStateGreetingGeneration(localTimeContext);
    return identityIntroResponse(
      [identityIntro, ...FALLBACK_GREETINGS],
      "workspace",
      refreshing,
    );
  }

  // 4. Trigger fresh generation without blocking the empty-state UI.
  const refreshing = triggerEmptyStateGreetingGeneration(localTimeContext);

  // 5. Generic fallback only when generation is unavailable.
  return identityIntroResponse(FALLBACK_GREETINGS, "fallback", refreshing);
}

function buildLocalTimeContext(
  queryParams: Record<string, string>,
): string | null {
  const rawHour = queryParams.localHour;
  const rawMinute = queryParams.localMinute;
  if (rawHour === undefined || rawMinute === undefined) {
    return null;
  }

  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  const period =
    hour >= 5 && hour < 12
      ? "morning"
      : hour >= 12 && hour < 17
        ? "afternoon"
        : hour >= 17 && hour < 21
          ? "evening"
          : "late night";
  const paddedHour = String(hour).padStart(2, "0");
  const paddedMinute = String(minute).padStart(2, "0");
  return `${period} (${paddedHour}:${paddedMinute})`;
}

function triggerEmptyStateGreetingGeneration(
  localTimeContext: string | null,
): boolean {
  if (greetingGenerationInFlight) {
    return true;
  }

  if (
    lastGreetingGenerationFailureAt > 0 &&
    Date.now() - lastGreetingGenerationFailureAt <
      GREETING_GENERATION_FAILURE_COOLDOWN_MS
  ) {
    return false;
  }

  greetingGenerationInFlight = new Promise<void>((resolve) => {
    queueMicrotask(() => {
      void generateEmptyStateGreetings(localTimeContext)
        .then((greetings) => {
          lastGreetingGenerationFailureAt = greetings === null ? Date.now() : 0;
        })
        .finally(() => {
          greetingGenerationInFlight = null;
          resolve();
        });
    });
  });

  return true;
}

async function generateEmptyStateGreetings(
  localTimeContext: string | null,
): Promise<string[] | null> {
  try {
    const provider = await getConfiguredProvider(EMPTY_STATE_GREETING_CALLSITE);
    if (!provider) {
      return null;
    }

    const resolved = resolveCallSiteConfig(
      EMPTY_STATE_GREETING_CALLSITE,
      getConfig().llm,
    );
    const systemPrompt = buildSystemPrompt({
      excludeBootstrap: true,
      excludeCustomPrefix: true,
    });
    const localTimeInstruction = localTimeContext
      ? ` Current user-local time for subtle tone only: ${localTimeContext}.`
      : "";
    const result = await runBtwSidechain({
      content:
        `Generate ${GENERATED_GREETING_LIMIT} short first-person greeting options for the empty new-chat screen. ` +
        "Use the assistant identity, voice, and relationship guidance from IDENTITY.md and SOUL.md. " +
        "Each greeting should feel personal and inviting, not like a generic assistant introduction. " +
        "Return only a JSON array of strings. No markdown, keys, or explanation. " +
        "Generated greetings are cached for 4 hours, so do not mention the current time " +
        "or use explicit time-of-day words like morning, afternoon, evening, or tonight." +
        localTimeInstruction,
      provider,
      systemPrompt,
      messages: [],
      tools: [],
      callSite: EMPTY_STATE_GREETING_CALLSITE,
      maxTokens: resolved.maxTokens,
      timeoutMs: GREETING_GENERATION_TIMEOUT_MS,
    });

    const greetings = parseGeneratedGreetings(result.text);
    if (greetings.length === 0) {
      return null;
    }

    setCachedIntro(greetings);
    return greetings;
  } catch (err) {
    getLogger("identity").warn(
      { err },
      "Failed to generate empty-state greetings",
    );
    return null;
  }
}

function parseGeneratedGreetings(text: string): string[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed)) {
      return normalizeGeneratedGreetings(parsed);
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { greetings?: unknown }).greetings)
    ) {
      return normalizeGeneratedGreetings(
        (parsed as { greetings: unknown[] }).greetings,
      );
    }
  } catch {
    // Fall through to line parsing for non-JSON model output.
  }

  return normalizeGeneratedGreetings(cleaned.split("\n"));
}

function normalizeGeneratedGreetings(values: unknown[]): string[] {
  const greetings: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (typeof value !== "string") continue;
    const greeting = value
      .trim()
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim();
    if (!greeting) continue;
    if (EXPLICIT_TIME_OF_DAY_PATTERN.test(greeting)) continue;

    const key = greeting.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    greetings.push(greeting);

    if (greetings.length >= GENERATED_GREETING_LIMIT) break;
  }

  return greetings;
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
  {
    operationId: "identity_intro",
    endpoint: "identity/intro",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: getIdentityIntro,
    summary: "Get identity greetings",
    description:
      "Returns greetings sourced from SOUL.md, the generated cache, or generic fallbacks while background generation refreshes the cache.",
    tags: ["identity"],
    queryParams: [
      {
        name: "localHour",
        schema: { type: "integer", minimum: 0, maximum: 23 },
        description:
          "Optional client-local hour of day used only when refreshing generated greetings.",
      },
      {
        name: "localMinute",
        schema: { type: "integer", minimum: 0, maximum: 59 },
        description:
          "Optional client-local minute used only when refreshing generated greetings.",
      },
    ],
    responseBody: z.object({
      greetings: z.array(z.string()),
      text: z.string(),
      source: z.enum(["workspace", "cache", "fallback"]),
      refreshing: z.boolean(),
    }),
  },
];
