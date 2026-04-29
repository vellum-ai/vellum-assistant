/**
 * Disk space guard — periodic monitor that locks the assistant when disk
 * usage reaches a critical threshold (95%).
 *
 * When locked, the assistant refuses to process new messages or run agent
 * loops until either:
 *   1. Disk usage drops below the threshold, or
 *   2. A manual override is issued via the `/v1/disk-lock/override` endpoint.
 *
 * The guard reuses the same `statfsSync` approach as the `/healthz` endpoint
 * to read disk metrics.
 */

import { existsSync, statfsSync } from "node:fs";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("disk-space-guard");

// ---------------------------------------------------------------------------
// Thresholds & timing
// ---------------------------------------------------------------------------

/** Lock the assistant when disk usage reaches or exceeds this fraction. */
const DISK_CRITICAL_THRESHOLD = 0.95;

/** How often (ms) to re-check disk usage. */
const DEFAULT_CHECK_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let locked = false;
let overrideActive = false;
let lastUsageFraction: number | null = null;
let checkTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Disk sampling (mirrors getDiskSpaceInfo in identity-routes.ts)
// ---------------------------------------------------------------------------

function sampleDiskUsage(): number | null {
  try {
    const wsDir = getWorkspaceDir();
    const diskPath = existsSync(wsDir) ? wsDir : "/";
    const stats = statfsSync(diskPath);
    const totalBytes = stats.bsize * stats.blocks;
    const freeBytes = stats.bsize * stats.bavail;
    if (totalBytes === 0) return null;
    return (totalBytes - freeBytes) / totalBytes;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core evaluation
// ---------------------------------------------------------------------------

function evaluate(): void {
  const usage = sampleDiskUsage();
  if (usage === null) return;

  lastUsageFraction = usage;

  if (usage >= DISK_CRITICAL_THRESHOLD) {
    if (!locked) {
      locked = true;
      overrideActive = false;
      log.warn(
        { usagePct: Math.round(usage * 100) },
        "Disk usage critical — assistant locked",
      );
    }
  } else {
    if (locked) {
      log.info(
        { usagePct: Math.round(usage * 100) },
        "Disk usage below threshold — assistant unlocked",
      );
    }
    locked = false;
    overrideActive = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start the periodic disk-usage check. Safe to call multiple times. */
export function startDiskSpaceGuard(
  intervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
): void {
  if (checkTimer !== null) return;

  // Run an initial check synchronously so the guard is armed from startup.
  evaluate();

  checkTimer = setInterval(evaluate, intervalMs);
  // Allow the process to exit even if the timer is still running.
  if (checkTimer && typeof checkTimer === "object" && "unref" in checkTimer) {
    checkTimer.unref();
  }
  log.info({ intervalMs }, "Disk space guard started");
}

/** Stop the periodic check. */
export function stopDiskSpaceGuard(): void {
  if (checkTimer !== null) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

/**
 * Returns `true` when the assistant should be prevented from processing.
 * The assistant is locked when disk usage >= 95% AND no manual override
 * is active.
 */
export function isDiskSpaceLocked(): boolean {
  return locked && !overrideActive;
}

/**
 * Manually override the disk lock so the assistant can continue operating
 * despite high disk usage. The override persists until disk usage drops
 * below the threshold (which clears both lock and override) or until the
 * daemon restarts.
 */
export function overrideDiskLock(): void {
  overrideActive = true;
  log.info("Disk lock manually overridden");
}

/** Current status snapshot for the `/v1/disk-lock/status` endpoint. */
export function getDiskLockStatus(): {
  locked: boolean;
  overrideActive: boolean;
  effectivelyLocked: boolean;
  diskUsagePercent: number | null;
  threshold: number;
} {
  return {
    locked,
    overrideActive,
    effectivelyLocked: isDiskSpaceLocked(),
    diskUsagePercent:
      lastUsageFraction !== null ? Math.round(lastUsageFraction * 100) : null,
    threshold: Math.round(DISK_CRITICAL_THRESHOLD * 100),
  };
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

export function _resetForTests(): void {
  stopDiskSpaceGuard();
  locked = false;
  overrideActive = false;
  lastUsageFraction = null;
}
