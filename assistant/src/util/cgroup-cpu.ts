/**
 * Container CPU accounting from the cgroup v2 `cpu.stat` file. The throttle
 * counters are the ones that matter for stall diagnosis: a rising
 * `throttledUsec` means the container hit its CPU quota and the kernel paused
 * its threads — from userspace that is indistinguishable from a busy event
 * loop unless this counter is recorded.
 */

import { readFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";

import { getCpuLimit, getIsPlatform } from "../config/env-registry.js";
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

/**
 * Parse a Kubernetes-style CPU string (e.g. "2000m", "1", "500m") into
 * fractional cores. Returns null if the value is not a recognized format.
 */
export function parseK8sCpuCores(value: string): number | null {
  const trimmed = value.trim();
  const milliMatch = trimmed.match(/^(\d+)m$/);
  if (milliMatch) {
    const millis = parseInt(milliMatch[1], 10);
    return millis > 0 ? millis / 1000 : null;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const num = parseFloat(trimmed);
    return !isNaN(num) && num > 0 ? num : null;
  }
  return null;
}

/**
 * Read the container's CPU core limit.
 *
 * Resolution order:
 * 1. VELLUM_CPU_LIMIT env var (K8s resource format, e.g. "2000m" or "2").
 *    In platform mode the container runs under gVisor where cgroup files may
 *    report the node's CPU count rather than the sandbox limit.
 * 2. cgroups v2 cpu.max (quota / period → fractional cores).
 * 3. cgroups v1 cpu.cfs_quota_us / cpu.cfs_period_us.
 * 4. os.cpus().length as last resort.
 */
export function getContainerCpuCores(): number {
  // 1. Prefer the explicit env var set by the platform StatefulSet template.
  try {
    const envLimit = getCpuLimit();
    if (envLimit) {
      const parsed = parseK8sCpuCores(envLimit);
      if (parsed !== null) {
        return parsed;
      }
    }
  } catch {
    /* env var parsing failed – fall through */
  }

  // 2. Try cgroups v2: /sys/fs/cgroup/cpu.max contains "$MAX $PERIOD".
  try {
    const raw = readFileSync("/sys/fs/cgroup/cpu.max", "utf-8").trim();
    if (!raw.startsWith("max")) {
      const parts = raw.split(/\s+/);
      const quota = parseInt(parts[0], 10);
      const period = parseInt(parts[1], 10);
      if (!isNaN(quota) && !isNaN(period) && period > 0 && quota > 0) {
        const cores = quota / period;
        // Sanity check: if the value looks like the node's full CPU count
        // and we're on a platform pod, it's likely gVisor leaking the host value.
        if (cores < cpus().length * 0.9 || !getIsPlatform()) {
          return cores;
        }
      }
    }
  } catch {
    /* not available */
  }

  // 3. Try cgroups v1.
  try {
    const quota = parseInt(
      readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf-8").trim(),
      10,
    );
    const period = parseInt(
      readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf-8").trim(),
      10,
    );
    if (!isNaN(quota) && !isNaN(period) && period > 0 && quota > 0) {
      const cores = quota / period;
      if (cores < cpus().length * 0.9 || !getIsPlatform()) {
        return cores;
      }
    }
  } catch {
    /* not available */
  }

  // 4. Fall back to the visible CPU count; 0 when even that syscall fails.
  try {
    return cpus().length || availableParallelism();
  } catch {
    return 0;
  }
}
