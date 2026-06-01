import type { DiskPressureStatus } from "@vellumai/assistant-api";

export type DiskPressureMonitorMode =
  | "inactive"
  | "warning"
  | "acknowledgement-required"
  | "cleanup";

export const DISK_PRESSURE_POLL_INTERVAL_MS = 60_000;

function isDiskPressureLockActive(
  status: DiskPressureStatus | null | undefined,
): status is DiskPressureStatus {
  return Boolean(status?.enabled && status.effectivelyLocked);
}

export function isDiskPressureCleanupActive(
  status: DiskPressureStatus | null | undefined,
): boolean {
  if (!isDiskPressureLockActive(status)) {
    return false;
  }

  return status.acknowledged && !status.overrideActive;
}

export function requiresDiskPressureAcknowledgement(
  status: DiskPressureStatus | null | undefined,
): boolean {
  return Boolean(
    status &&
      isDiskPressureLockActive(status) &&
      !status.acknowledged &&
      !status.overrideActive,
  );
}

function isDiskPressureWarning(
  status: DiskPressureStatus | null | undefined,
): boolean {
  return Boolean(status?.enabled && status.state === "warning");
}

export function shouldShowDiskPressureBanner(
  status: DiskPressureStatus | null | undefined,
): boolean {
  return (
    isDiskPressureWarning(status) ||
    requiresDiskPressureAcknowledgement(status) ||
    isDiskPressureCleanupActive(status)
  );
}

export function getDiskPressureMonitorMode(
  status: DiskPressureStatus | null | undefined,
): DiskPressureMonitorMode {
  if (requiresDiskPressureAcknowledgement(status)) {
    return "acknowledgement-required";
  }

  if (isDiskPressureCleanupActive(status)) {
    return "cleanup";
  }

  if (isDiskPressureWarning(status)) {
    return "warning";
  }

  return "inactive";
}

export function isChatInputDisabledByDiskPressure({
  monitorEnabled,
  hasResolvedStatus,
  status,
}: {
  monitorEnabled: boolean;
  hasResolvedStatus: boolean;
  status: DiskPressureStatus | null;
}): boolean {
  return getDiskPressureChatBlockReason({
    monitorEnabled,
    hasResolvedStatus,
    status,
  }) !== null;
}

export type DiskPressureChatBlockReason = "acknowledgement-required";

export function getDiskPressureChatBlockReason({
  monitorEnabled,
  hasResolvedStatus,
  status,
}: {
  monitorEnabled: boolean;
  hasResolvedStatus: boolean;
  status: DiskPressureStatus | null;
}): DiskPressureChatBlockReason | null {
  if (!monitorEnabled) {
    return null;
  }

  // Do not block while the status is still loading — let the user type freely
  // until we know acknowledgement is actually required.
  if (!hasResolvedStatus) {
    return null;
  }

  return requiresDiskPressureAcknowledgement(status)
    ? "acknowledgement-required"
    : null;
}

export function getDiskPressureChatBlockMessage(
  _reason: DiskPressureChatBlockReason,
): string {
  return "Storage cleanup mode must be acknowledged before sending messages.";
}

export function areDiskPressureStatusesEqual(
  left: DiskPressureStatus | null,
  right: DiskPressureStatus | null,
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.enabled === right.enabled &&
    left.state === right.state &&
    left.locked === right.locked &&
    left.acknowledged === right.acknowledged &&
    left.overrideActive === right.overrideActive &&
    left.effectivelyLocked === right.effectivelyLocked &&
    left.lockId === right.lockId &&
    left.usagePercent === right.usagePercent &&
    left.thresholdPercent === right.thresholdPercent &&
    left.path === right.path &&
    left.lastCheckedAt === right.lastCheckedAt &&
    left.error === right.error &&
    left.blockedCapabilities.length === right.blockedCapabilities.length &&
    left.blockedCapabilities.every(
      (capability, index) => capability === right.blockedCapabilities[index],
    )
  );
}

export function formatDiskPressureUsage(
  status: DiskPressureStatus | null | undefined,
): string {
  if (status?.usagePercent == null || !Number.isFinite(status.usagePercent)) {
    return "Unknown";
  }

  return `${Math.round(status.usagePercent)}%`;
}
