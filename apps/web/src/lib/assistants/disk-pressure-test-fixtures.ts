import type { DiskPressureStatus } from "@/lib/assistants/api.js";

export function createDiskPressureStatus(
  overrides: Partial<DiskPressureStatus> = {},
): DiskPressureStatus {
  return {
    enabled: true,
    state: "ok",
    locked: false,
    acknowledged: false,
    overrideActive: false,
    effectivelyLocked: false,
    lockId: null,
    usagePercent: 42,
    thresholdPercent: 90,
    path: "/workspace",
    lastCheckedAt: "2026-05-05T12:00:00.000Z",
    blockedCapabilities: [],
    error: null,
    ...overrides,
  };
}

export function createCriticalDiskPressureStatus(
  overrides: Partial<DiskPressureStatus> = {},
): DiskPressureStatus {
  return createDiskPressureStatus({
    state: "critical",
    locked: true,
    acknowledged: false,
    effectivelyLocked: true,
    lockId: "lock-123",
    usagePercent: 94,
    blockedCapabilities: [
      "agent-turns",
      "background-work",
      "remote-ingress",
    ],
    ...overrides,
  });
}
