import type { DiskPressureStatus } from "../disk-pressure-guard.js";

/** Server push when the disk pressure status snapshot changes. */
export interface DiskPressureStatusChanged {
  type: "disk_pressure_status_changed";
  status: DiskPressureStatus;
}

export type _DiskPressureServerMessages = DiskPressureStatusChanged;
