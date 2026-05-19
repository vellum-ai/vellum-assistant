// TODO: port from platform
export type DiskPressureChatBlockReason = "critical" | "warning" | null;

export interface DiskPressureInfo {
  monitorEnabled?: boolean;
  acknowledged?: boolean;
  hasResolvedStatus?: boolean;
  status?: unknown;
}

export function useDiskPressure() { return { isUnderPressure: false, diskPressureMonitorEnabled: false, hasResolvedDiskPressureStatus: false, status: undefined }; }
export function getDiskPressureChatBlockReason(_info?: DiskPressureInfo): DiskPressureChatBlockReason { return null; }
export function getDiskPressureChatBlockMessage(_reason: DiskPressureChatBlockReason): string { return ""; }
