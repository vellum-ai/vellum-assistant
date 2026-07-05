/**
 * Container CPU accounting from the cgroup v2 `cpu.stat` file. The throttle
 * counters are the ones that matter for stall diagnosis: a rising
 * `throttledUsec` means the container hit its CPU quota and the kernel paused
 * its threads — from userspace that is indistinguishable from a busy event
 * loop unless this counter is recorded.
 */

import { readFileSync } from "node:fs";

import { parseKeyedCounts } from "./cgroup-memory.js";

export interface ContainerCpuStat {
  usageUsec: number | null;
  userUsec: number | null;
  systemUsec: number | null;
  nrPeriods: number | null;
  nrThrottled: number | null;
  throttledUsec: number | null;
}

/** Parse cgroup v2 `cpu.stat` content. Missing counters are null. */
export function parseCpuStat(raw: string): ContainerCpuStat {
  const counts = parseKeyedCounts(raw);
  return {
    usageUsec: counts.usage_usec ?? null,
    userUsec: counts.user_usec ?? null,
    systemUsec: counts.system_usec ?? null,
    nrPeriods: counts.nr_periods ?? null,
    nrThrottled: counts.nr_throttled ?? null,
    throttledUsec: counts.throttled_usec ?? null,
  };
}

/** Raw cgroup v2 `cpu.stat` content, or null on cgroups v1 / unreadable. */
export function readCpuStatRaw(): string | null {
  try {
    return readFileSync("/sys/fs/cgroup/cpu.stat", "utf-8");
  } catch {
    return null;
  }
}

export function getContainerCpuStat(): ContainerCpuStat | null {
  const raw = readCpuStatRaw();
  return raw != null ? parseCpuStat(raw) : null;
}
