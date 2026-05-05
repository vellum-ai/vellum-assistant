import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { cancelBackgroundTools } from "../tools/background-tool-registry.js";
import { getDiskUsageInfo } from "../util/disk-usage.js";
import { getLogger } from "../util/logger.js";

export const DISK_PRESSURE_THRESHOLD_PERCENT = 95;
export const DISK_PRESSURE_CHECK_INTERVAL_MS = 60_000;
export const DISK_PRESSURE_OVERRIDE_CONFIRMATION = "I understand the risks";
export const DISK_PRESSURE_BLOCKED_CAPABILITIES = [
  "agent-turns",
  "background-work",
  "remote-ingress",
] as const;

export type DiskPressureState = "disabled" | "ok" | "critical" | "unknown";

export type DiskPressureBlockedCapability =
  (typeof DISK_PRESSURE_BLOCKED_CAPABILITIES)[number];

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

export type DiskPressureTransitionResult =
  | { ok: true; status: DiskPressureStatus }
  | {
      ok: false;
      reason:
        | "not_locked"
        | "already_acknowledged"
        | "already_overridden"
        | "invalid_confirmation";
      message: string;
      status: DiskPressureStatus;
    };

interface DiskPressureGuardState {
  timer: ReturnType<typeof setInterval> | null;
  status: DiskPressureStatus;
}

const log = getLogger("disk-pressure-guard");

const DISABLED_STATUS: DiskPressureStatus = {
  enabled: false,
  state: "disabled",
  locked: false,
  acknowledged: false,
  overrideActive: false,
  effectivelyLocked: false,
  lockId: null,
  usagePercent: null,
  thresholdPercent: DISK_PRESSURE_THRESHOLD_PERCENT,
  path: null,
  lastCheckedAt: null,
  blockedCapabilities: [],
  error: null,
};

const OPEN_STATUS: DiskPressureStatus = {
  ...DISABLED_STATUS,
  enabled: true,
  state: "ok",
  thresholdPercent: DISK_PRESSURE_THRESHOLD_PERCENT,
};

const state: DiskPressureGuardState = {
  timer: null,
  status: cloneStatus(DISABLED_STATUS),
};

function cloneStatus(status: DiskPressureStatus): DiskPressureStatus {
  return {
    ...status,
    blockedCapabilities: [...status.blockedCapabilities],
  };
}

function statusFingerprint(status: DiskPressureStatus): string {
  const { lastCheckedAt: _lastCheckedAt, ...substantiveStatus } = status;
  return JSON.stringify(substantiveStatus);
}

function publishStatusChangedIfNeeded(previous: DiskPressureStatus): void {
  if (statusFingerprint(previous) === statusFingerprint(state.status)) return;
  const status = cloneStatus(state.status);
  assistantEventHub
    .publish(
      buildAssistantEvent({
        type: "disk_pressure_status_changed",
        status,
      }),
    )
    .catch((err) => {
      log.warn({ err }, "Failed to publish disk pressure status change");
    });
}

function replaceStatus(next: DiskPressureStatus): DiskPressureStatus {
  const previous = cloneStatus(state.status);
  state.status = cloneStatus(next);
  publishStatusChangedIfNeeded(previous);
  return cloneStatus(state.status);
}

function isEnabled(): boolean {
  return isAssistantFeatureFlagEnabled("safe-storage-limits", getConfig());
}

function resetToDisabled(): DiskPressureStatus {
  const previous = cloneStatus(state.status);
  stopDiskPressureGuard();
  state.status = cloneStatus(DISABLED_STATUS);
  publishStatusChangedIfNeeded(previous);
  return cloneStatus(state.status);
}

function ensureEnabledStatus(): DiskPressureStatus | null {
  if (!isEnabled()) return resetToDisabled();
  if (!state.status.enabled) {
    state.status = cloneStatus(OPEN_STATUS);
  }
  return null;
}

function nextLockId(): string {
  return `disk-pressure-${Date.now()}`;
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sampleFailureStatus(error: unknown): DiskPressureStatus {
  const now = new Date().toISOString();
  return {
    ...state.status,
    enabled: true,
    state: "unknown",
    locked: false,
    acknowledged: false,
    overrideActive: false,
    effectivelyLocked: false,
    lockId: null,
    usagePercent: null,
    thresholdPercent: DISK_PRESSURE_THRESHOLD_PERCENT,
    path: null,
    lastCheckedAt: now,
    blockedCapabilities: [],
    error: formatError(error),
  };
}

function cancelTerminalBackgroundToolsForLock(): void {
  const cancelled = cancelBackgroundTools(
    (tool) => tool.toolName === "bash" || tool.toolName === "host_bash",
    "disk_pressure",
  );
  if (cancelled.length === 0) return;
  log.info(
    { count: cancelled.length, ids: cancelled.map((tool) => tool.id) },
    "Cancelled background terminal tools during disk pressure lock",
  );
}

function rejectTransition(
  reason: Exclude<DiskPressureTransitionResult, { ok: true }>["reason"],
  message: string,
  status: DiskPressureStatus,
): DiskPressureTransitionResult {
  return { ok: false, reason, message, status };
}

export function startDiskPressureGuard(): DiskPressureStatus {
  const disabledStatus = ensureEnabledStatus();
  if (disabledStatus) return disabledStatus;

  if (!state.timer) {
    state.timer = setInterval(() => {
      void evaluateDiskPressureNow();
    }, DISK_PRESSURE_CHECK_INTERVAL_MS);
    (state.timer as { unref?: () => void }).unref?.();
  }

  return cloneStatus(state.status);
}

export function stopDiskPressureGuard(): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
}

export function evaluateDiskPressureNow(): DiskPressureStatus {
  const disabledStatus = ensureEnabledStatus();
  if (disabledStatus) return disabledStatus;

  let usageInfo: ReturnType<typeof getDiskUsageInfo>;
  try {
    usageInfo = getDiskUsageInfo();
  } catch (error) {
    return replaceStatus(sampleFailureStatus(error));
  }

  if (!usageInfo || usageInfo.totalMb <= 0) {
    return replaceStatus(sampleFailureStatus("Disk usage sample unavailable"));
  }

  const usagePercent = roundPercent(
    (usageInfo.usedMb / usageInfo.totalMb) * 100,
  );
  const isCritical = usagePercent >= DISK_PRESSURE_THRESHOLD_PERCENT;
  const lastCheckedAt = new Date().toISOString();

  if (!isCritical) {
    return replaceStatus({
      ...OPEN_STATUS,
      usagePercent,
      path: usageInfo.path,
      lastCheckedAt,
    });
  }

  if (!state.status.locked) {
    cancelTerminalBackgroundToolsForLock();
  }

  const lockId = state.status.locked ? state.status.lockId : nextLockId();
  return replaceStatus({
    enabled: true,
    state: "critical",
    locked: true,
    acknowledged: state.status.locked ? state.status.acknowledged : false,
    overrideActive: state.status.locked ? state.status.overrideActive : false,
    effectivelyLocked: state.status.locked
      ? !state.status.overrideActive
      : true,
    lockId,
    usagePercent,
    thresholdPercent: DISK_PRESSURE_THRESHOLD_PERCENT,
    path: usageInfo.path,
    lastCheckedAt,
    blockedCapabilities: [...DISK_PRESSURE_BLOCKED_CAPABILITIES],
    error: null,
  });
}

export function getDiskPressureStatus(): DiskPressureStatus {
  if (!isEnabled()) return cloneStatus(DISABLED_STATUS);
  if (!state.status.enabled) return cloneStatus(OPEN_STATUS);
  return cloneStatus(state.status);
}

export function acknowledgeDiskPressureLock(): DiskPressureTransitionResult {
  const disabledStatus = ensureEnabledStatus();
  const status = disabledStatus ?? cloneStatus(state.status);
  if (!status.locked) {
    return rejectTransition(
      "not_locked",
      "No disk pressure lock is active for this assistant.",
      status,
    );
  }

  if (status.acknowledged) {
    return rejectTransition(
      "already_acknowledged",
      "The disk pressure lock has already been acknowledged.",
      status,
    );
  }

  const previous = cloneStatus(state.status);
  state.status.acknowledged = true;
  publishStatusChangedIfNeeded(previous);
  return { ok: true, status: cloneStatus(state.status) };
}

export function overrideDiskPressureLock(
  confirmation: string,
): DiskPressureTransitionResult {
  const disabledStatus = ensureEnabledStatus();
  const status = disabledStatus ?? cloneStatus(state.status);
  if (!status.locked) {
    return rejectTransition(
      "not_locked",
      "No disk pressure lock is active for this assistant.",
      status,
    );
  }

  if (status.overrideActive) {
    return rejectTransition(
      "already_overridden",
      "The disk pressure lock has already been overridden.",
      status,
    );
  }

  if (confirmation.trim() !== DISK_PRESSURE_OVERRIDE_CONFIRMATION) {
    return rejectTransition(
      "invalid_confirmation",
      `Type "${DISK_PRESSURE_OVERRIDE_CONFIRMATION}" to resume normal assistant behavior.`,
      status,
    );
  }

  const previous = cloneStatus(state.status);
  state.status.overrideActive = true;
  state.status.effectivelyLocked = false;
  publishStatusChangedIfNeeded(previous);
  return { ok: true, status: cloneStatus(state.status) };
}

export function __resetDiskPressureGuardForTests(): void {
  stopDiskPressureGuard();
  state.status = cloneStatus(DISABLED_STATUS);
}

export function __getDiskPressureGuardTimerForTests(): ReturnType<
  typeof setInterval
> | null {
  return state.timer;
}
