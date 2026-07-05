/**
 * The resource monitor's sampling loop.
 *
 * On a fast timer (default 250ms) it reads the container's own cgroup memory
 * accounting and workspace-disk usage and appends a compact sample to an
 * on-disk ring buffer. When memory crosses a configurable fraction of the
 * container limit it also captures a one-off "high-memory" snapshot — cgroup
 * stats plus the live process tree with per-process memory accounting — so a
 * spike leaves behind a record of *what was running* when it happened.
 *
 * Everything here runs in the resource monitor's own OS process, off the
 * assistant's main event loop, so it keeps sampling even while that loop is
 * frozen mid-allocation and the samples survive an OOM SIGKILL. That
 * independence is also what lets each tick check the daemon's event-loop
 * heartbeat and capture the daemon's kernel-side state *during* a stall
 * (`stall-capture.ts`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MonitoringConfig } from "../config/schemas/monitoring.js";
import {
  type ContainerCpuStat,
  getContainerCpuStat,
} from "../util/cgroup-cpu.js";
import {
  type ContainerMemoryEvents,
  type ContainerMemoryStat,
  type ContainerReclaimCounters,
  getContainerMemoryEvents,
  getContainerMemoryLimitBytes,
  getContainerMemoryPeakBytes,
  getContainerMemoryUsageBytes,
  parseMemoryStat,
  parseReclaimCounters,
  readMemoryStatRaw,
} from "../util/cgroup-memory.js";
import { diffCounters } from "../util/counter-diff.js";
import { getDiskUsageInfo } from "../util/disk-usage.js";
import { getLogger } from "../util/logger.js";
import { getMonitoringDataDir } from "../util/platform.js";
import { buildProcessTree, listProcesses } from "../util/process-tree.js";
import { getTrackedDataFiles, readFileResidency } from "./page-cache.js";
import { topProcessesByMemory } from "./process-memory.js";
import { prunePrefixedJsonFiles } from "./prune-snapshots.js";
import { SampleRingBuffer } from "./sample-ring-buffer.js";
import { topSlabCaches } from "./slabinfo.js";
import { createStallCaptureMonitor } from "./stall-capture.js";

const log = getLogger("resource-sampler");

const SAMPLES_FILE = "samples.jsonl";
const SNAPSHOTS_DIR = "snapshots";
/** Cap on retained high-memory snapshots so forensics can't fill the volume. */
const MAX_SNAPSHOTS = 20;

export interface ResourceSampleMemory {
  currentBytes: number;
  limitBytes: number | null;
  peakBytes: number | null;
  /** current / limit, or null when the limit is unknown. */
  ratio: number | null;
}

export interface ResourceSampleDisk {
  path: string;
  usedMb: number;
  totalMb: number;
  freeMb: number;
}

/**
 * Counter increases since the previous sample. The cumulative since-boot
 * counters answer "has this ever happened"; the deltas are what turn a stall
 * into a timeline — a burst of `reclaim.pgscanDirect` across a few samples *is*
 * the synchronous-reclaim stall, invisible in the cumulative totals.
 */
export interface ResourceSampleDeltas {
  events: ContainerMemoryEvents | null;
  reclaim: ContainerReclaimCounters | null;
  cpu: ContainerCpuStat | null;
}

export interface ResourceSample {
  ts: number;
  memory: ResourceSampleMemory | null;
  /**
   * memory.stat breakdown (anon / file / kernel / slab, plus the derived
   * unevictable vs reclaimable split). `memory.currentBytes` alone cannot say
   * whether the cgroup is filling with process heap or with droppable cache.
   */
  memoryStat: ContainerMemoryStat | null;
  /** Cumulative reclaim/thrash counters from memory.stat (since boot). */
  reclaim: ContainerReclaimCounters | null;
  /**
   * Cumulative cpu.stat counters (since boot). A rising `throttledUsec` delta
   * means the container hit its CPU quota and the kernel paused its threads —
   * indistinguishable from a busy event loop without this.
   */
  cpu: ContainerCpuStat | null;
  events: ContainerMemoryEvents | null;
  /** Since the previous sample; null on the monitor's first sample. */
  deltas: ResourceSampleDeltas | null;
  disk: ResourceSampleDisk | null;
}

/** Per-counter increases from `prev` to `current`. */
export function computeSampleDeltas(
  prev: ResourceSample,
  current: ResourceSample,
): ResourceSampleDeltas {
  return {
    events: diffCounters(prev.events, current.events),
    reclaim: diffCounters(prev.reclaim, current.reclaim),
    cpu: diffCounters(prev.cpu, current.cpu),
  };
}

/**
 * Take a single point-in-time sample of memory + disk. When `prev` is given,
 * the sample carries counter deltas relative to it.
 */
export function takeSample(
  now: number,
  prev: ResourceSample | null = null,
): ResourceSample {
  const currentBytes = getContainerMemoryUsageBytes();
  const limitBytes = getContainerMemoryLimitBytes();
  const memory: ResourceSampleMemory | null =
    currentBytes != null
      ? {
          currentBytes,
          limitBytes,
          peakBytes: getContainerMemoryPeakBytes(),
          ratio: limitBytes != null ? currentBytes / limitBytes : null,
        }
      : null;

  const disk = getDiskUsageInfo();

  // One read feeds both parsers so the breakdown and counters are coherent.
  const statRaw = readMemoryStatRaw();

  const sample: ResourceSample = {
    ts: now,
    memory,
    memoryStat: statRaw != null ? parseMemoryStat(statRaw) : null,
    reclaim: statRaw != null ? parseReclaimCounters(statRaw) : null,
    cpu: getContainerCpuStat(),
    events: getContainerMemoryEvents(),
    deltas: null,
    disk: disk
      ? {
          path: disk.path,
          usedMb: disk.usedMb,
          totalMb: disk.totalMb,
          freeMb: disk.freeMb,
        }
      : null,
  };
  if (prev != null) {
    sample.deltas = computeSampleDeltas(prev, sample);
  }
  return sample;
}

/**
 * Capture a high-memory snapshot to the snapshots directory: the triggering
 * sample, page-cache residency of the large data files, the top processes by
 * PSS, the top kernel slab caches, and the full process tree of the container.
 * Prunes to {@link MAX_SNAPSHOTS} newest.
 */
export async function writeHighMemSnapshot(
  dataDir: string,
  sample: ResourceSample,
): Promise<void> {
  const snapshotsDir = join(dataDir, SNAPSHOTS_DIR);
  // The ring buffer only creates the data dir for samples.jsonl; the nested
  // snapshots dir may not exist yet on the first threshold crossing.
  mkdirSync(snapshotsDir, { recursive: true });

  let tree: unknown = null;
  try {
    const procs = await listProcesses();
    // pid 1 is the container init; its subtree is the whole container.
    tree = buildProcessTree(procs, 1);
  } catch (err) {
    log.warn({ err }, "Failed to enumerate process tree for snapshot");
  }

  // Attributes the memory.stat `file` charge to specific files (SQLite DB +
  // WAL, largest qdrant segments); null when fincore is unavailable.
  let fileResidency: Awaited<ReturnType<typeof readFileResidency>> = null;
  try {
    fileResidency = await readFileResidency(getTrackedDataFiles());
  } catch (err) {
    log.warn({ err }, "Failed to read page-cache residency for snapshot");
  }

  const snapshot = {
    ts: sample.ts,
    sample,
    fileResidency,
    // PSS-ranked with per-process anon/file split; PSS sums reconcile against
    // the cgroup total where an RSS sum double-counts shared pages.
    topProcesses: topProcessesByMemory(15),
    // Slab memory belongs to no process; without this, cgroup usage that
    // exceeds the per-process sum has no visible owner.
    topSlabCaches: topSlabCaches(10),
    processTree: tree,
  };

  const filename = `snapshot-${sample.ts}.json`;
  writeFileSync(
    join(snapshotsDir, filename),
    JSON.stringify(snapshot, null, 2),
  );
  prunePrefixedJsonFiles(snapshotsDir, "snapshot-", MAX_SNAPSHOTS);
  log.warn(
    {
      currentBytes: sample.memory?.currentBytes,
      limitBytes: sample.memory?.limitBytes,
      ratio: sample.memory?.ratio,
      unevictableBytes: sample.memoryStat?.unevictableBytes,
      reclaimableBytes: sample.memoryStat?.reclaimableBytes,
      pgscanDirectDelta: sample.deltas?.reclaim?.pgscanDirect,
      workingsetRefaultFileDelta: sample.deltas?.reclaim?.workingsetRefaultFile,
      file: filename,
    },
    "Captured high-memory snapshot",
  );
}

export interface ResourceSamplerHandle {
  stop: () => void;
}

/**
 * Start the sampling loop. Returns a handle whose `stop()` clears the timer.
 * The timer is intentionally *not* unref'd: in the standalone monitor process
 * it is the keep-alive that holds the process open.
 */
export function startResourceSampler(
  config: MonitoringConfig,
  clock: () => number = Date.now,
): ResourceSamplerHandle {
  const dataDir = getMonitoringDataDir();
  const buffer = new SampleRingBuffer<ResourceSample>(
    join(dataDir, SAMPLES_FILE),
    config.ringBufferSize,
  );

  let lastSnapshotAt = 0;
  let prevSample: ResourceSample | null = null;
  // Watches the daemon's event-loop heartbeat; captures the daemon main
  // thread's kernel state mid-stall when the heartbeat goes stale.
  const stallCapture = createStallCaptureMonitor(dataDir);

  const tick = () => {
    const now = clock();
    let sample: ResourceSample;
    try {
      sample = takeSample(now, prevSample);
      prevSample = sample;
      buffer.append(sample);
    } catch (err) {
      log.warn({ err }, "Resource sample failed");
      return;
    }

    try {
      stallCapture.check(sample, now);
    } catch (err) {
      log.warn({ err }, "Daemon stall check failed");
    }

    const ratio = sample.memory?.ratio;
    if (
      ratio != null &&
      ratio >= config.highMemThresholdRatio &&
      now - lastSnapshotAt >= config.snapshotCooldownMs
    ) {
      lastSnapshotAt = now;
      void writeHighMemSnapshot(dataDir, sample).catch((err) =>
        log.warn({ err }, "Failed to write high-memory snapshot"),
      );
    }
  };

  const timer = setInterval(tick, config.sampleIntervalMs);

  return {
    stop: () => clearInterval(timer),
  };
}
