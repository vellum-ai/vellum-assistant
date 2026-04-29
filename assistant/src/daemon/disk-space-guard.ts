/**
 * Disk space guard — periodic monitor that locks the assistant when disk
 * usage reaches a critical threshold (95%).
 *
 * When locked:
 *   - Background tasks and non-guardian messages are blocked entirely.
 *   - Guardian messages are allowed through but the agent loop injects
 *     context forcing the assistant to focus on diagnosing and resolving
 *     the disk usage problem.
 *
 * The lock clears automatically when disk usage drops below the threshold.
 * A manual override (requiring a typed confirmation phrase) allows full
 * unrestricted operation despite high disk usage.
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

/** Phrase the user must type to confirm the override. */
export const OVERRIDE_CONFIRMATION_PHRASE = "I understand the risks";

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
 * Returns `true` when the assistant is in disk-pressure mode (disk >= 95%).
 * In this state, guardian messages are allowed through with restricted context
 * but background tasks and non-guardian messages are blocked entirely.
 */
export function isDiskSpacePressure(): boolean {
  return locked && !overrideActive;
}

/**
 * Returns `true` when the assistant should be fully prevented from processing.
 * Kept for backward compatibility — equivalent to `isDiskSpacePressure()`.
 */
export function isDiskSpaceLocked(): boolean {
  return isDiskSpacePressure();
}

/**
 * Manually override the disk lock so the assistant can continue operating
 * without restrictions despite high disk usage. Requires the caller to
 * supply the correct confirmation phrase.
 *
 * Returns `true` if the override was accepted, `false` if the phrase was wrong.
 */
export function overrideDiskLock(confirmationPhrase: string): boolean {
  if (confirmationPhrase.trim() !== OVERRIDE_CONFIRMATION_PHRASE) {
    log.warn("Disk lock override rejected — incorrect confirmation phrase");
    return false;
  }
  overrideActive = true;
  log.info("Disk lock manually overridden");
  return true;
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
    effectivelyLocked: isDiskSpacePressure(),
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
