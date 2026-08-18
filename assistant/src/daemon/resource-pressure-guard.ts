/**
 * Sustained CPU/memory pressure guard for platform-hosted assistants.
 *
 * Samples container CPU utilization and working-set memory against the
 * container's allocation on a fixed cadence and reports an `elevated` state
 * only when a signal stays over its threshold for nearly the whole sampling
 * window (so a single heavy agent task never trips it). Clearing requires a
 * sustained run of samples below a lower clear threshold (hysteresis), so the
 * state never flaps while usage hovers near a threshold.
 *
 * The guard is platform-gated: off-platform there is no plan allocation to
 * measure against, so the guard stays disabled and samples nothing.
 */
import {
  type ResourcePressureState,
  type ResourcePressureStatus,
} from "../api/events/resource-pressure-status-changed.js";
import { getIsPlatform } from "../config/env-registry.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getContainerCpuCores } from "../util/cgroup-cpu.js";
import {
  getContainerMemoryLimitBytes,
  getContainerMemoryStat,
  getContainerMemoryUsageBytes,
} from "../util/cgroup-memory.js";
import { getCachedContainerCpuPercent } from "../util/container-cpu-sampler.js";

export const RESOURCE_PRESSURE_SAMPLE_INTERVAL_MS = 30_000;
// 20 samples at a 30s cadence: 10 minutes of history.
export const RESOURCE_PRESSURE_WINDOW_SAMPLES = 20;
// A signal must exceed its threshold in at least this many of the last
// RESOURCE_PRESSURE_WINDOW_SAMPLES samples, with the window full, to enter
// `elevated`.
export const RESOURCE_PRESSURE_ENTER_SAMPLES = 18;
// Consecutive samples below the clear threshold (5 minutes) required to leave
// `elevated`.
export const RESOURCE_PRESSURE_CLEAR_CONSECUTIVE_SAMPLES = 10;
export const CPU_PRESSURE_THRESHOLD_PERCENT = 85;
export const CPU_PRESSURE_CLEAR_THRESHOLD_PERCENT = 70;
export const MEMORY_PRESSURE_THRESHOLD_PERCENT = 90;
export const MEMORY_PRESSURE_CLEAR_THRESHOLD_PERCENT = 80;

export { type ResourcePressureState, type ResourcePressureStatus };

export interface ResourcePressureMemorySample {
  usageBytes: number;
  limitBytes: number;
  reclaimableBytes: number;
}

export interface ResourcePressureSamplers {
  sampleCpuPercent?: () => number | null;
  sampleMemory?: () => ResourcePressureMemorySample | null;
}

interface SignalWindow {
  /** Ring buffer of over-threshold results, oldest first. */
  overThreshold: boolean[];
  consecutiveBelowClear: number;
  elevated: boolean;
}

interface ResourcePressureGuardState {
  timer: ReturnType<typeof setInterval> | null;
  status: ResourcePressureStatus;
  cpuWindow: SignalWindow;
  memoryWindow: SignalWindow;
}

const DISABLED_STATUS: ResourcePressureStatus = {
  enabled: false,
  state: "disabled",
  cpuPercent: null,
  memoryPercent: null,
  cpuElevated: false,
  memoryElevated: false,
  cpuThresholdPercent: CPU_PRESSURE_THRESHOLD_PERCENT,
  memoryThresholdPercent: MEMORY_PRESSURE_THRESHOLD_PERCENT,
  lastCheckedAt: null,
  error: null,
};

const OK_STATUS: ResourcePressureStatus = {
  ...DISABLED_STATUS,
  enabled: true,
  state: "ok",
};

function emptySignalWindow(): SignalWindow {
  return { overThreshold: [], consecutiveBelowClear: 0, elevated: false };
}

const state: ResourcePressureGuardState = {
  timer: null,
  status: cloneStatus(DISABLED_STATUS),
  cpuWindow: emptySignalWindow(),
  memoryWindow: emptySignalWindow(),
};

function cloneStatus(status: ResourcePressureStatus): ResourcePressureStatus {
  return { ...status };
}

// The raw percents and timestamp change on every sample; broadcasting each
// tick would spam the SSE hub, so only substantive fields participate.
function statusFingerprint(status: ResourcePressureStatus): string {
  const {
    lastCheckedAt: _lastCheckedAt,
    cpuPercent: _cpuPercent,
    memoryPercent: _memoryPercent,
    ...substantiveStatus
  } = status;
  return JSON.stringify(substantiveStatus);
}

function publishStatusChangedIfNeeded(previous: ResourcePressureStatus): void {
  if (statusFingerprint(previous) === statusFingerprint(state.status)) {
    return;
  }
  const status = cloneStatus(state.status);
  broadcastMessage({
    type: "resource_pressure_status_changed",
    status,
  });
}

function replaceStatus(next: ResourcePressureStatus): ResourcePressureStatus {
  const previous = cloneStatus(state.status);
  state.status = cloneStatus(next);
  publishStatusChangedIfNeeded(previous);
  return cloneStatus(state.status);
}

function ensureEnabledStatus(): void {
  if (!state.status.enabled) {
    state.status = cloneStatus(OK_STATUS);
  }
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sampleFailureStatus(error: unknown): ResourcePressureStatus {
  return {
    ...OK_STATUS,
    state: "unknown",
    lastCheckedAt: new Date().toISOString(),
    error: formatError(error),
  };
}

function resetSignalWindow(window: SignalWindow): void {
  window.overThreshold = [];
  window.consecutiveBelowClear = 0;
  window.elevated = false;
}

/**
 * Feed one sample into a signal's window and derive its elevated flag.
 *
 * An unavailable sample (null percent) resets the window: the signal cannot
 * hold `elevated` without data, and a fresh full window is required before it
 * can enter again.
 */
function updateSignal(
  window: SignalWindow,
  percent: number | null,
  thresholdPercent: number,
  clearThresholdPercent: number,
): boolean {
  if (percent === null) {
    resetSignalWindow(window);
    return false;
  }

  window.overThreshold.push(percent >= thresholdPercent);
  if (window.overThreshold.length > RESOURCE_PRESSURE_WINDOW_SAMPLES) {
    window.overThreshold.shift();
  }
  if (percent < clearThresholdPercent) {
    window.consecutiveBelowClear += 1;
  } else {
    window.consecutiveBelowClear = 0;
  }

  if (window.elevated) {
    // Hysteresis: hold until enough consecutive samples land below the clear
    // threshold.
    if (
      window.consecutiveBelowClear >=
      RESOURCE_PRESSURE_CLEAR_CONSECUTIVE_SAMPLES
    ) {
      window.elevated = false;
    }
  } else {
    const overCount = window.overThreshold.filter(Boolean).length;
    window.elevated =
      window.overThreshold.length >= RESOURCE_PRESSURE_WINDOW_SAMPLES &&
      overCount >= RESOURCE_PRESSURE_ENTER_SAMPLES;
  }

  return window.elevated;
}

function defaultSampleCpuPercent(): number | null {
  if (getContainerCpuCores() <= 0) {
    return null;
  }
  return getCachedContainerCpuPercent();
}

function defaultSampleMemory(): ResourcePressureMemorySample | null {
  const limitBytes = getContainerMemoryLimitBytes();
  const usageBytes = getContainerMemoryUsageBytes();
  if (limitBytes === null || limitBytes <= 0 || usageBytes === null) {
    return null;
  }
  return {
    usageBytes,
    limitBytes,
    // Raw usage includes page cache the kernel can drop under pressure;
    // counting it would false-positive, so the working set subtracts it.
    reclaimableBytes: getContainerMemoryStat()?.reclaimableBytes ?? 0,
  };
}

export function startResourcePressureGuard(): ResourcePressureStatus {
  if (!getIsPlatform()) {
    return cloneStatus(state.status);
  }

  ensureEnabledStatus();

  if (!state.timer) {
    state.timer = setInterval(() => {
      evaluateResourcePressureNow();
    }, RESOURCE_PRESSURE_SAMPLE_INTERVAL_MS);
    (state.timer as { unref?: () => void }).unref?.();
  }

  return cloneStatus(state.status);
}

export function stopResourcePressureGuard(): void {
  if (!state.timer) {
    return;
  }
  clearInterval(state.timer);
  state.timer = null;
}

export function evaluateResourcePressureNow(
  deps?: ResourcePressureSamplers,
): ResourcePressureStatus {
  if (!getIsPlatform()) {
    return cloneStatus(state.status);
  }

  ensureEnabledStatus();

  const sampleCpuPercent = deps?.sampleCpuPercent ?? defaultSampleCpuPercent;
  const sampleMemory = deps?.sampleMemory ?? defaultSampleMemory;

  let sampleError: unknown = null;

  let cpuPercent: number | null = null;
  try {
    cpuPercent = sampleCpuPercent();
  } catch (error) {
    sampleError = error;
  }

  let memoryPercent: number | null = null;
  try {
    const memorySample = sampleMemory();
    if (memorySample && memorySample.limitBytes > 0) {
      const workingSetBytes = Math.max(
        0,
        memorySample.usageBytes - memorySample.reclaimableBytes,
      );
      memoryPercent = roundPercent(
        (workingSetBytes / memorySample.limitBytes) * 100,
      );
    }
  } catch (error) {
    sampleError = error;
  }

  if (cpuPercent === null && memoryPercent === null) {
    resetSignalWindow(state.cpuWindow);
    resetSignalWindow(state.memoryWindow);
    return replaceStatus(
      sampleFailureStatus(
        sampleError ?? "Resource pressure samples unavailable",
      ),
    );
  }

  const cpuElevated = updateSignal(
    state.cpuWindow,
    cpuPercent,
    CPU_PRESSURE_THRESHOLD_PERCENT,
    CPU_PRESSURE_CLEAR_THRESHOLD_PERCENT,
  );
  const memoryElevated = updateSignal(
    state.memoryWindow,
    memoryPercent,
    MEMORY_PRESSURE_THRESHOLD_PERCENT,
    MEMORY_PRESSURE_CLEAR_THRESHOLD_PERCENT,
  );

  return replaceStatus({
    ...OK_STATUS,
    state: cpuElevated || memoryElevated ? "elevated" : "ok",
    cpuPercent,
    memoryPercent,
    cpuElevated,
    memoryElevated,
    lastCheckedAt: new Date().toISOString(),
  });
}

export function getResourcePressureStatus(): ResourcePressureStatus {
  if (!getIsPlatform()) {
    return cloneStatus(DISABLED_STATUS);
  }
  if (!state.status.enabled) {
    return cloneStatus(OK_STATUS);
  }
  return cloneStatus(state.status);
}

export function __resetResourcePressureGuardForTests(): void {
  stopResourcePressureGuard();
  state.status = cloneStatus(DISABLED_STATUS);
  resetSignalWindow(state.cpuWindow);
  resetSignalWindow(state.memoryWindow);
}

export function __getResourcePressureGuardTimerForTests(): ReturnType<
  typeof setInterval
> | null {
  return state.timer;
}
