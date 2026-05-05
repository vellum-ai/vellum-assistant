import {
  type DiskPressureBlockedCapability,
  type DiskPressureStatus,
  getDiskPressureStatus,
} from "./disk-pressure-guard.js";

export type DiskPressureBackgroundGateDecision =
  | { action: "allow"; status: DiskPressureStatus }
  | {
      action: "skip";
      reason: "disk_pressure";
      status: DiskPressureStatus;
      blockedCapability: DiskPressureBlockedCapability;
    };

export const DISK_PRESSURE_BACKGROUND_LOG_THROTTLE_MS = 60_000;

const lastSkipLogAtByKey = new Map<string, number>();

export function checkDiskPressureBackgroundGate(
  blockedCapability: DiskPressureBlockedCapability = "background-work",
): DiskPressureBackgroundGateDecision {
  const status = getDiskPressureStatus();
  if (!status.enabled || !status.locked || status.overrideActive) {
    return { action: "allow", status };
  }
  if (!status.effectivelyLocked) {
    return { action: "allow", status };
  }
  return {
    action: "skip",
    reason: "disk_pressure",
    status,
    blockedCapability,
  };
}

export function shouldLogDiskPressureBackgroundSkip(
  key: string,
  nowMs = Date.now(),
): boolean {
  const lastLoggedAt = lastSkipLogAtByKey.get(key) ?? 0;
  if (nowMs - lastLoggedAt < DISK_PRESSURE_BACKGROUND_LOG_THROTTLE_MS) {
    return false;
  }
  lastSkipLogAtByKey.set(key, nowMs);
  return true;
}

export function diskPressureBackgroundSkipLogFields(
  decision: Extract<DiskPressureBackgroundGateDecision, { action: "skip" }>,
): {
  reason: "disk_pressure";
  thresholdPercent: number;
  usagePercent: number | null;
  blockedCapability: DiskPressureBlockedCapability;
  lockId: string | null;
  path: string | null;
} {
  return {
    reason: decision.reason,
    thresholdPercent: decision.status.thresholdPercent,
    usagePercent: decision.status.usagePercent,
    blockedCapability: decision.blockedCapability,
    lockId: decision.status.lockId,
    path: decision.status.path,
  };
}

/** @internal */
export function __resetDiskPressureBackgroundGateForTests(): void {
  lastSkipLogAtByKey.clear();
}
