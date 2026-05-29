export type MaintenanceModeInfo = {
  enabled?: boolean;
};

/**
 * Discriminated union describing every phase the assistant can be in,
 * from initial load through active use and error states. Drives
 * top-level conditional rendering across the app shell and chat page.
 *
 * `loading` is the client-only initial phase before any `/assistant/`
 * response has resolved. Every other kind maps from
 * `resolveAssistantLifecycleState` of a server response plus
 * client-managed recovery state (retry exhaustion → `error`, version
 * selection in nonprod → `awaiting_version_selection`).
 */
export type AssistantState =
  | { kind: "loading" }
  | { kind: "initializing" }
  | { kind: "cleaning_up" }
  | { kind: "retired" }
  | { kind: "platform_hosted" }
  | { kind: "self_hosted" }
  | { kind: "awaiting_version_selection" }
  | { kind: "active"; isLocal: boolean; maintenanceMode?: MaintenanceModeInfo }
  | { kind: "error"; message: string };

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
