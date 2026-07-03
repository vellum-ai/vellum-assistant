/**
 * The resource monitor's sampling loop.
 *
 * On a fast timer (default 250ms) it reads the container's own cgroup memory
 * accounting and workspace-disk usage and appends a compact sample to an
 * on-disk ring buffer. When memory crosses a configurable fraction of the
 * container limit it also captures a one-off "high-memory" snapshot — cgroup
 * stats plus the live process tree with per-process RSS — so a spike leaves
 * behind a record of *what was running* when it happened.
 *
 * Everything here runs in the resource monitor's own OS process, off the
 * assistant's main event loop, so it keeps sampling even while that loop is
 * frozen mid-allocation and the samples survive an OOM SIGKILL.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { MonitoringConfig } from "../config/schemas/monitoring.js";
import {
  type ContainerMemoryEvents,
  type ContainerMemoryStat,
  getContainerMemoryEvents,
  getContainerMemoryLimitBytes,
  getContainerMemoryPeakBytes,
  getContainerMemoryStat,
  getContainerMemoryUsageBytes,
} from "../util/cgroup-memory.js";
import { getDiskUsageInfo } from "../util/disk-usage.js";
import { getLogger } from "../util/logger.js";
import { getMonitoringDataDir } from "../util/platform.js";
import { buildProcessTree, listProcesses } from "../util/process-tree.js";
import { SampleRingBuffer } from "./sample-ring-buffer.js";

const log = getLogger("resource-sampler");

const SAMPLES_FILE = "samples.jsonl";
const SNAPSHOTS_DIR = "snapshots";
/** Cap on retained high-memory snapshots so forensics can't fill the volume. */
const MAX_SNAPSHOTS = 20;
/** Linux page size assumed when converting `/proc/<pid>/statm` pages to bytes. */
const PAGE_SIZE_BYTES = 4096;

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

export interface ResourceSample {
  ts: number;
  memory: ResourceSampleMemory | null;
  /**
   * memory.stat breakdown (anon / file / kernel / slab, plus the derived
   * unevictable vs reclaimable split). `memory.currentBytes` alone cannot say
   * whether the cgroup is filling with process heap or with droppable cache.
   */
  memoryStat: ContainerMemoryStat | null;
  events: ContainerMemoryEvents | null;
  disk: ResourceSampleDisk | null;
}

/** Take a single point-in-time sample of memory + disk. */
export function takeSample(now: number): ResourceSample {
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

  return {
    ts: now,
    memory,
    memoryStat: getContainerMemoryStat(),
    events: getContainerMemoryEvents(),
    disk: disk
      ? {
          path: disk.path,
          usedMb: disk.usedMb,
          totalMb: disk.totalMb,
          freeMb: disk.freeMb,
        }
      : null,
  };
}

interface ProcessRss {
  pid: number;
  command: string;
  rssBytes: number;
}

/**
 * Best-effort per-process RSS read from `/proc/<pid>/statm` (resident pages,
 * field 2). Returns the top `limit` processes by RSS, largest first. Empty when
 * `/proc` is unavailable (e.g. macOS) — the snapshot's process *tree* still
 * captures what was running in that case.
 */
function topProcessesByRss(limit: number): ProcessRss[] {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((e) => /^\d+$/.test(e));
  } catch {
    return [];
  }

  const rows: ProcessRss[] = [];
  for (const entry of pids) {
    const pid = Number(entry);
    try {
      const statm = readFileSync(`/proc/${pid}/statm`, "utf-8").trim();
      const residentPages = parseInt(statm.split(/\s+/)[1], 10);
      if (!Number.isFinite(residentPages)) continue;
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      const command = raw.split("\0").filter(Boolean).join(" ") || `pid ${pid}`;
      rows.push({ pid, command, rssBytes: residentPages * PAGE_SIZE_BYTES });
    } catch {
      // Process exited between readdir and read — skip.
    }
  }

  rows.sort((a, b) => b.rssBytes - a.rssBytes);
  return rows.slice(0, limit);
}

/**
 * Capture a high-memory snapshot to the snapshots directory: the triggering
 * sample, the cgroup memory.events counters, the top processes by RSS, and the
 * full process tree of the container. Prunes to {@link MAX_SNAPSHOTS} newest.
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

  const snapshot = {
    ts: sample.ts,
    sample,
    topProcessesByRss: topProcessesByRss(15),
    processTree: tree,
  };

  const filename = `snapshot-${sample.ts}.json`;
  writeFileSync(
    join(snapshotsDir, filename),
    JSON.stringify(snapshot, null, 2),
  );
  pruneSnapshots(snapshotsDir);
  log.warn(
    {
      currentBytes: sample.memory?.currentBytes,
      limitBytes: sample.memory?.limitBytes,
      ratio: sample.memory?.ratio,
      unevictableBytes: sample.memoryStat?.unevictableBytes,
      reclaimableBytes: sample.memoryStat?.reclaimableBytes,
      file: filename,
    },
    "Captured high-memory snapshot",
  );
}

function pruneSnapshots(snapshotsDir: string): void {
  let files: string[];
  try {
    files = readdirSync(snapshotsDir).filter(
      (f) => f.startsWith("snapshot-") && f.endsWith(".json"),
    );
  } catch {
    return;
  }
  if (files.length <= MAX_SNAPSHOTS) return;
  // Filenames embed the millisecond timestamp, so lexical sort is chronological.
  files.sort();
  for (const stale of files.slice(0, files.length - MAX_SNAPSHOTS)) {
    try {
      rmSync(join(snapshotsDir, stale));
    } catch {
      // best-effort
    }
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

  const tick = () => {
    const now = clock();
    let sample: ResourceSample;
    try {
      sample = takeSample(now);
      buffer.append(sample);
    } catch (err) {
      log.warn({ err }, "Resource sample failed");
      return;
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
