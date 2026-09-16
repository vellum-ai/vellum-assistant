/**
 * Process-local readiness of the MCP tool surface this process hosts.
 *
 * MCP tools reach the registry only after every configured server has been
 * attempted. Until that pass settles, an execute/wake/workflow schedule that
 * fires would record success while `mcp__*` calls fail as unknown tools.
 * Notify and script schedules do not use that surface and keep firing.
 *
 * Default is ready so callers that never bootstrap MCP (existing scheduler
 * tests, the daemon's unused tick) are not blocked. The schedule worker
 * marks starting/reloading around its own connect.
 */

import {
  EMPTY_MCP_STARTUP_SNAPSHOT,
  type McpStartupSnapshot,
} from "../mcp/tool-caps.js";
import type { ScheduleMode } from "./schedule-store.js";

export type ScheduleToolSurfaceState = "ready" | "starting" | "reloading";

/** How far a claimed tool-backed schedule is pushed back while MCP is not ready. */
export const MCP_NOT_READY_DEFER_MS = 5_000;

let state: ScheduleToolSurfaceState = "ready";
let snapshot: McpStartupSnapshot = EMPTY_MCP_STARTUP_SNAPSHOT;

export function scheduleModeNeedsToolSurface(mode: ScheduleMode): boolean {
  return mode === "execute" || mode === "wake" || mode === "workflow";
}

export function isScheduleToolSurfaceReady(): boolean {
  return state === "ready";
}

export function getScheduleToolSurfaceState(): ScheduleToolSurfaceState {
  return state;
}

export function getScheduleToolSurfaceSnapshot(): McpStartupSnapshot {
  return snapshot;
}

export function markScheduleToolSurfaceStarting(
  configuredServerCount = 0,
): void {
  state = "starting";
  snapshot = { ...EMPTY_MCP_STARTUP_SNAPSHOT, configuredServerCount };
}

export function markScheduleToolSurfaceReloading(): void {
  state = "reloading";
}

export function markScheduleToolSurfaceReady(
  next: McpStartupSnapshot = EMPTY_MCP_STARTUP_SNAPSHOT,
): void {
  state = "ready";
  snapshot = next;
}

export function resetScheduleToolSurfaceReadinessForTests(): void {
  state = "ready";
  snapshot = EMPTY_MCP_STARTUP_SNAPSHOT;
}
