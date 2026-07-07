/**
 * Disk-pressure guard wiring for the daemon lifecycle.
 *
 * Starts the guard at boot and defers the first full sample onto a macrotask so
 * it never blocks startup, and stops the guard (cancelling any pending deferred
 * sample) on shutdown.
 */
import { getLogger } from "../util/logger.js";
import {
  evaluateDiskPressureNow,
  startDiskPressureGuard,
  stopDiskPressureGuard,
} from "./disk-pressure-guard.js";

const log = getLogger("disk-pressure-guard-lifecycle");

let diskPressureStartupSampleTimer: ReturnType<typeof setTimeout> | null = null;

function runDeferredDiskPressureStartupSample(): void {
  diskPressureStartupSampleTimer = null;
  try {
    const status = evaluateDiskPressureNow();
    if (status.error) {
      log.warn(
        { error: status.error },
        "Disk pressure guard sample failed during startup — continuing unlocked",
      );
    }
  } catch (err) {
    log.warn(
      { err },
      "Disk pressure guard failed during startup — continuing unlocked",
    );
  }
}

export function startDiskPressureGuardForLifecycle(): void {
  try {
    const startedStatus = startDiskPressureGuard();
    if (!startedStatus.enabled) {
      return;
    }
    if (!diskPressureStartupSampleTimer) {
      diskPressureStartupSampleTimer = setTimeout(
        runDeferredDiskPressureStartupSample,
        0,
      );
      (diskPressureStartupSampleTimer as { unref?: () => void }).unref?.();
    }
  } catch (err) {
    log.warn(
      { err },
      "Disk pressure guard failed during startup — continuing unlocked",
    );
  }
}

export function stopDiskPressureGuardForLifecycle(): void {
  if (diskPressureStartupSampleTimer) {
    clearTimeout(diskPressureStartupSampleTimer);
    diskPressureStartupSampleTimer = null;
  }
  stopDiskPressureGuard();
}
