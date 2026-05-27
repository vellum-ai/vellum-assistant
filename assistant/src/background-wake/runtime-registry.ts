import type { HeartbeatService } from "../heartbeat/heartbeat-service.js";
import type { SchedulerHandle } from "../schedule/scheduler.js";

export interface BackgroundWakeRuntime {
  scheduler: Pick<SchedulerHandle, "runOnce" | "runDueWorkOnce">;
  heartbeat: Pick<HeartbeatService, "nextRunAt" | "runManagedWakeIfDue">;
}

let runtime: BackgroundWakeRuntime | null = null;

export function registerBackgroundWakeRuntime(
  nextRuntime: BackgroundWakeRuntime,
): void {
  runtime = nextRuntime;
}

export function getBackgroundWakeRuntime(): BackgroundWakeRuntime | null {
  return runtime;
}

/** @internal Test helper for module-level route state. */
export function clearBackgroundWakeRuntime(): void {
  runtime = null;
}
