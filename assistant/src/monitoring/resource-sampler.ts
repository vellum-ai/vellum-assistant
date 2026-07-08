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
import { getContainerCpuStat } from "../util/cgroup-cpu.js";
import {
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
import { readActiveConversations } from "./active-conversations.js";
import { getTrackedDataFiles, readFileResidency } from "./page-cache.js";
import { topProcessesByMemory } from "./process-memory.js";
import { prunePrefixedJsonFiles } from "./prune-snapshots.js";
import type {
  ResourceSample,
  ResourceSampleDeltas,
  ResourceSampleMemory,
} from "./resource-sample-types.js";
import { SampleRingBuffer } from "./sample-ring-buffer.js";
import { topSlabCaches } from "./slabinfo.js";
import { createStallCaptureMonitor } from "./stall-capture.js";

const log = getLogger("resource-sampler");

const SAMPLES_FILE = "samples.jsonl";
const SNAPSHOTS_DIR = "snapshots";
/** Cap on retained high-memory snapshots so forensics can't fill the volume. */
const MAX_SNAPSHOTS = 20;
/** Cap on retained baseline snapshots (4h of history at the 10min default). */
const MAX_BASELINE_SNAPSHOTS = 24;

/** Snapshot kinds: filename prefix + retention are per-kind so periodic
 * baselines can never evict high-memory forensics. */
const SNAPSHOT_KINDS = {
  "high-mem": { prefix: "snapshot-", max: MAX_SNAPSHOTS },
  baseline: { prefix: "baseline-", max: MAX_BASELINE_SNAPSHOTS },
} as const;

type SnapshotKind = keyof typeof SNAPSHOT_KINDS;

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
    activeConversations: readActiveConversations(),
  };
  if (prev != null) {
    sample.deltas = computeSampleDeltas(prev, sample);
  }
  return sample;
}

/**
 * Capture a full snapshot to the snapshots directory: the triggering sample,
 * page-cache residency of the large data files, the top processes by PSS, the
 * top kernel slab caches, and the full process tree of the container.
 *
 * `high-mem` snapshots fire when memory crosses the configured threshold;
 * `baseline` snapshots fire on a slow periodic timer so there is always a
 * healthy capture to diff a spike against — threshold-only snapshots record
 * the system once already over the cliff. Each kind prunes independently.
 */
export async function writeSnapshot(
  dataDir: string,
  sample: ResourceSample,
  kind: SnapshotKind,
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
    kind,
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

  const { prefix, max } = SNAPSHOT_KINDS[kind];
  const filename = `${prefix}${sample.ts}.json`;
  writeFileSync(
    join(snapshotsDir, filename),
    JSON.stringify(snapshot, null, 2),
  );
  prunePrefixedJsonFiles(snapshotsDir, prefix, max);
  const fields = {
    currentBytes: sample.memory?.currentBytes,
    limitBytes: sample.memory?.limitBytes,
    ratio: sample.memory?.ratio,
    unevictableBytes: sample.memoryStat?.unevictableBytes,
    reclaimableBytes: sample.memoryStat?.reclaimableBytes,
    pgscanDirectDelta: sample.deltas?.reclaim?.pgscanDirect,
    workingsetRefaultFileDelta: sample.deltas?.reclaim?.workingsetRefaultFile,
    file: filename,
  };
  if (kind === "high-mem") {
    log.warn(fields, "Captured high-memory snapshot");
  } else {
    log.debug(fields, "Captured baseline snapshot");
  }
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
  // 0 so the first tick writes a boot baseline — a reference point exists even
  // if the container spikes before the first interval elapses.
  let lastBaselineAt = 0;
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
      void writeSnapshot(dataDir, sample, "high-mem").catch((err) =>
        log.warn({ err }, "Failed to write high-memory snapshot"),
      );
    } else if (now - lastBaselineAt >= config.baselineSnapshotIntervalMs) {
      lastBaselineAt = now;
      void writeSnapshot(dataDir, sample, "baseline").catch((err) =>
        log.warn({ err }, "Failed to write baseline snapshot"),
      );
    }
  };

  const timer = setInterval(tick, config.sampleIntervalMs);

  return {
    stop: () => clearInterval(timer),
  };
}
