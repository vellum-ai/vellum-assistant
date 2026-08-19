/**
 * Rolling container CPU sampler.
 *
 * Tracks CPU usage over a rolling window so consumers (e.g. /v1/health) report
 * near-real-time utilization instead of a lifetime average (total CPU time /
 * total uptime). The sampler starts on module import and runs on an unref'd
 * interval, so it never prevents process exit.
 */

import { readFileSync } from "node:fs";

import { getIsPlatform } from "../config/env-registry.js";
import { getContainerCpuCores } from "./cgroup-cpu.js";

/**
 * Read the container's CPU usage from cgroup accounting files.
 *
 * Returns total CPU microseconds consumed by the container since boot.
 * We use the delta between two samples to compute percentage.
 */
function getContainerCpuUsageUs(): number | null {
  // cgroups v2: cpu.stat has a "usage_usec" line.
  try {
    const stat = readFileSync("/sys/fs/cgroup/cpu.stat", "utf-8");
    for (const line of stat.split("\n")) {
      if (line.startsWith("usage_usec")) {
        const val = parseInt(line.split(/\s+/)[1], 10);
        if (!isNaN(val) && val > 0) {
          return val;
        }
      }
    }
  } catch {
    /* not available */
  }

  // cgroups v1: cpuacct.usage is in nanoseconds.
  try {
    const ns = parseInt(
      readFileSync("/sys/fs/cgroup/cpuacct/cpuacct.usage", "utf-8").trim(),
      10,
    );
    if (!isNaN(ns) && ns > 0) {
      return ns / 1000;
    } // convert ns → µs
  } catch {
    /* not available */
  }

  return null;
}

const CPU_SAMPLE_INTERVAL_MS = 5_000;

/**
 * Sample this process's cumulative CPU time, returning null when the
 * underlying syscall fails.
 */
function sampleProcessCpuUsage(): NodeJS.CpuUsage | null {
  try {
    return process.cpuUsage();
  } catch {
    return null;
  }
}

/**
 * Convert a CPU-time delta into a percent of the container's full allocation,
 * rounded to 2 decimal places. Callers must guard `numCores > 0` and
 * `elapsedMs > 0`; a zero divisor yields a non-finite result.
 */
export function computeCpuPercent(
  deltaCpuUs: number,
  elapsedMs: number,
  numCores: number,
): number {
  const deltaCpuMs = deltaCpuUs / 1000;
  return Math.round((deltaCpuMs / (elapsedMs * numCores)) * 10000) / 100;
}

// Recent per-tick percents are retained so consumers with a coarser cadence
// (the resource-pressure guard samples every 30s) can average the 5s windows
// inside their own interval instead of reading one instantaneous value; a
// workload that spikes in phase with the coarser cadence would otherwise
// alias into a sustained-high reading.
const RECENT_SAMPLE_RETENTION_MS = 5 * 60 * 1000;

let _lastProcessCpuUsage: NodeJS.CpuUsage | null = sampleProcessCpuUsage();
let _lastCgroupCpuUs: number | null = getContainerCpuUsageUs();
let _lastCpuTime: number = Date.now();
let _cachedCpuPercent = 0;
// Whether the sampler has ever computed a real delta. Until then the cache
// is a placeholder 0 (still warming up, or neither cgroup counters nor
// process.cpuUsage() deltas are readable), not a measurement.
let _hasCpuSample = false;
let _recentSamples: { at: number; percent: number; elapsedMs: number }[] = [];

function setCachedCpuPercent(
  percent: number,
  at: number,
  elapsedMs: number,
): void {
  _cachedCpuPercent = percent;
  _hasCpuSample = true;
  _recentSamples.push({ at, percent, elapsedMs });
  const cutoff = at - RECENT_SAMPLE_RETENTION_MS;
  while (_recentSamples.length > 0 && _recentSamples[0].at < cutoff) {
    _recentSamples.shift();
  }
}

function runCpuSamplerTick(now: number): void {
  const elapsedMs = now - _lastCpuTime;
  if (elapsedMs <= 0) {
    return;
  }

  const numCores = getContainerCpuCores();
  if (numCores <= 0) {
    _lastCpuTime = now;
    return;
  }

  // Always sample process-level CPU so the baseline stays fresh. This
  // prevents a spike if the platform cgroup path later falls back to
  // process.cpuUsage() after cgroup stats were previously available.
  const newProcessUsage = sampleProcessCpuUsage();
  const processDeltaUs =
    newProcessUsage !== null && _lastProcessCpuUsage !== null
      ? newProcessUsage.user -
        _lastProcessCpuUsage.user +
        (newProcessUsage.system - _lastProcessCpuUsage.system)
      : null;
  if (newProcessUsage !== null) {
    _lastProcessCpuUsage = newProcessUsage;
  }

  if (getIsPlatform()) {
    // In platform mode, prefer cgroup-level CPU usage so we see the full
    // container footprint, not just this process.
    const cgroupUs = getContainerCpuUsageUs();
    if (cgroupUs !== null && _lastCgroupCpuUs !== null) {
      setCachedCpuPercent(
        computeCpuPercent(cgroupUs - _lastCgroupCpuUs, elapsedMs, numCores),
        now,
        elapsedMs,
      );
    } else if (processDeltaUs !== null) {
      // cgroup CPU stats unavailable (e.g. gVisor) – fall back to process-level.
      setCachedCpuPercent(
        computeCpuPercent(processDeltaUs, elapsedMs, numCores),
        now,
        elapsedMs,
      );
    }
    _lastCgroupCpuUs = cgroupUs;
  } else if (processDeltaUs !== null) {
    // Non-platform: use process.cpuUsage() (accurate for single-process mode).
    setCachedCpuPercent(
      computeCpuPercent(processDeltaUs, elapsedMs, numCores),
      now,
      elapsedMs,
    );
  }

  _lastCpuTime = now;
}

// Kick off the background sampler. unref() so it never prevents process exit.
setInterval(() => {
  runCpuSamplerTick(Date.now());
}, CPU_SAMPLE_INTERVAL_MS).unref();

/**
 * Near-real-time CPU utilization as a percent of the container's full
 * allocation, refreshed every {@link CPU_SAMPLE_INTERVAL_MS}.
 *
 * Reports 0 until the sampler computes its first delta; callers that must
 * distinguish "idle" from "no data yet" use
 * {@link getCachedContainerCpuPercentOrNull}.
 */
export function getCachedContainerCpuPercent(): number {
  return _cachedCpuPercent;
}

/**
 * Like {@link getCachedContainerCpuPercent}, but null until the sampler has
 * computed at least one real delta, so warm-up and unreadable CPU accounting
 * read as "signal unavailable" instead of a genuine-looking 0%.
 */
export function getCachedContainerCpuPercentOrNull(): number | null {
  return _hasCpuSample ? _cachedCpuPercent : null;
}

/**
 * Duration-weighted mean of per-tick percents over the window starting at
 * `windowStartMs`. Each tick's percent covers the wall time its delta
 * spanned (ending at `at`), so a delayed tick must weigh proportionally
 * more than an on-schedule one, and only the part of a tick's interval
 * that overlaps the window may contribute: a long delayed tick ending just
 * inside the window would otherwise import load that predates it.
 */
export function computeDurationWeightedMeanPercent(
  samples: readonly { at: number; percent: number; elapsedMs: number }[],
  windowStartMs: number,
): number | null {
  let weightedSum = 0;
  let totalOverlapMs = 0;
  for (const sample of samples) {
    const intervalStart = sample.at - sample.elapsedMs;
    const overlapMs = sample.at - Math.max(intervalStart, windowStartMs);
    if (overlapMs > 0) {
      weightedSum += sample.percent * overlapMs;
      totalOverlapMs += overlapMs;
    }
  }
  if (totalOverlapMs <= 0) {
    return null;
  }
  return Math.round((weightedSum / totalOverlapMs) * 100) / 100;
}

/**
 * Duration-weighted mean of the per-tick percents recorded within the
 * trailing `windowMs`, rounded to 2 decimal places, or null when no tick
 * overlaps the window. Coarser-cadence consumers use this instead of the
 * instantaneous cache so a short spike aligned with their cadence cannot
 * read as sustained load.
 */
export function getAverageContainerCpuPercentOrNull(
  windowMs: number,
): number | null {
  return computeDurationWeightedMeanPercent(
    _recentSamples,
    Date.now() - windowMs,
  );
}

export function __resetContainerCpuSamplerForTests(): void {
  _lastProcessCpuUsage = sampleProcessCpuUsage();
  _lastCgroupCpuUs = getContainerCpuUsageUs();
  _lastCpuTime = Date.now();
  _cachedCpuPercent = 0;
  _hasCpuSample = false;
  _recentSamples = [];
}

export function __runContainerCpuSamplerTickForTests(nowMs: number): void {
  runCpuSamplerTick(nowMs);
}
