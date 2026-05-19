// TODO: port from platform
import type { DiskPressureStatus } from "./types.js";

export type DiskPressureStatusEventPayload = DiskPressureStatus | null;

export function useDiskPressureMonitor() { return { isUnderPressure: false }; }
