/**
 * Identity and health endpoint handlers.
 */

import { existsSync, readFileSync, statfsSync, statSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getBaseDataDir } from "../../config/env-registry.js";
import { parseIdentityFields } from "../../daemon/handlers/identity.js";
import { getMaxMigrationVersion } from "../../memory/migrations/registry.js";
import { getWorkspacePromptPath } from "../../util/platform.js";
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
    const baseDataDir = getBaseDataDir();
    const diskPath = baseDataDir && existsSync(baseDataDir) ? baseDataDir : "/";
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
}

// Read the container memory limit from cgroups if available, falling back to host total.
// cgroups v2: /sys/fs/cgroup/memory.max (returns "max" when unlimited)
// cgroups v1: /sys/fs/cgroup/memory/memory.limit_in_bytes (large sentinel when unlimited)
function getContainerMemoryLimitBytes(): number | null {
  try {
    const v2 = readFileSync("/sys/fs/cgroup/memory.max", "utf-8").trim();
    if (v2 !== "max") {
      const bytes = parseInt(v2, 10);
      if (!isNaN(bytes) && bytes > 0) return bytes;
    }
  } catch {
    /* not available */
  }
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

function getMemoryInfo(): MemoryInfo {
  const bytesToMb = (b: number) => Math.round((b / (1024 * 1024)) * 100) / 100;
  return {
    currentMb: bytesToMb(process.memoryUsage().rss),
    maxMb: bytesToMb(getContainerMemoryLimitBytes() ?? totalmem()),
  };
}

interface CpuInfo {
  currentPercent: number;
  maxCores: number;
}

// Track CPU usage over a rolling window so /healthz reports near-real-time
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
  });
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
// Route definitions
// ---------------------------------------------------------------------------

export function identityRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "health",
      method: "GET",
      handler: () => handleHealth(),
    },
    {
      endpoint: "identity",
      method: "GET",
      handler: () => handleGetIdentity(),
    },
    {
      endpoint: "identity/intro",
      method: "GET",
      handler: () => handleGetIdentityIntro(),
    },
  ];
}
