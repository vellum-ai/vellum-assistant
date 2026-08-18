import type { ResourcePressureStatus } from "@vellumai/assistant-api";

export type ResourcePressureMonitorMode = "inactive" | "warning";

export const RESOURCE_PRESSURE_POLL_INTERVAL_MS = 60_000;

export function getResourcePressureMonitorMode(
  status: ResourcePressureStatus | null | undefined,
): ResourcePressureMonitorMode {
  if (status?.enabled && status.state === "elevated") {
    return "warning";
  }

  return "inactive";
}

export function areResourcePressureStatusesEqual(
  left: ResourcePressureStatus | null,
  right: ResourcePressureStatus | null,
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
    left.cpuPercent === right.cpuPercent &&
    left.memoryPercent === right.memoryPercent &&
    left.cpuElevated === right.cpuElevated &&
    left.memoryElevated === right.memoryElevated &&
    left.cpuThresholdPercent === right.cpuThresholdPercent &&
    left.memoryThresholdPercent === right.memoryThresholdPercent &&
    left.lastCheckedAt === right.lastCheckedAt &&
    left.error === right.error
  );
}
