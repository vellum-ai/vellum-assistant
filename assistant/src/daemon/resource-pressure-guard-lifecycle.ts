/**
 * Resource-pressure guard wiring for the daemon lifecycle.
 *
 * Starts the guard at boot and defers the first sample onto a macrotask so it
 * never blocks startup, and stops the guard (cancelling any pending deferred
 * sample) on shutdown. When the guard is disabled (non-platform), no deferred
 * sample is scheduled.
 */
import { getLogger } from "../util/logger.js";
import {
  evaluateResourcePressureNow,
  startResourcePressureGuard,
  stopResourcePressureGuard,
} from "./resource-pressure-guard.js";

const log = getLogger("resource-pressure-guard-lifecycle");

let resourcePressureStartupSampleTimer: ReturnType<typeof setTimeout> | null =
  null;

function runDeferredResourcePressureStartupSample(): void {
  resourcePressureStartupSampleTimer = null;
  try {
    const status = evaluateResourcePressureNow();
    if (status.error) {
      log.warn(
        { error: status.error },
        "Resource pressure guard sample failed during startup, continuing",
      );
    }
  } catch (err) {
    log.warn(
      { err },
      "Resource pressure guard failed during startup, continuing",
    );
  }
}

export function startResourcePressureGuardForLifecycle(): void {
  try {
    const startedStatus = startResourcePressureGuard();
    if (!startedStatus.enabled) {
      return;
    }
    if (!resourcePressureStartupSampleTimer) {
      resourcePressureStartupSampleTimer = setTimeout(
        runDeferredResourcePressureStartupSample,
        0,
      );
      (resourcePressureStartupSampleTimer as { unref?: () => void }).unref?.();
    }
  } catch (err) {
    log.warn(
      { err },
      "Resource pressure guard failed during startup, continuing",
    );
  }
}

export function stopResourcePressureGuardForLifecycle(): void {
  if (resourcePressureStartupSampleTimer) {
    clearTimeout(resourcePressureStartupSampleTimer);
    resourcePressureStartupSampleTimer = null;
  }
  stopResourcePressureGuard();
}
