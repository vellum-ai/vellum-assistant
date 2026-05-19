export type DiskPressureState = "disabled" | "ok" | "critical" | "unknown";

export type DiskPressureBlockedCapability =
  | "agent-turns"
  | "background-work"
  | "remote-ingress";

export interface DiskPressureStatus {
  enabled: boolean;
  state: DiskPressureState;
  locked: boolean;
  acknowledged: boolean;
  overrideActive: boolean;
  effectivelyLocked: boolean;
  lockId: string | null;
  usagePercent: number | null;
  thresholdPercent: number;
  path: string | null;
  lastCheckedAt: string | null;
  blockedCapabilities: DiskPressureBlockedCapability[];
  error: string | null;
}
