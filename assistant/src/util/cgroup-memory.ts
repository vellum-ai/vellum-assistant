/**
 * Container memory accounting read from cgroup files (and the platform
 * `VELLUM_MEMORY_LIMIT` override).
 *
 * Shared by the `/v1/health` identity handler (which reports current + max) and
 * the resource monitor (which additionally samples the peak and the
 * memory.events pressure counters). Keeping the cgroup v2→v1 fallbacks in one
 * place means a single source of truth for how the assistant reads its own
 * memory footprint.
 */

import { readFileSync } from "node:fs";
import { totalmem } from "node:os";

import { parseK8sMemoryBytes } from "./disk-usage.js";

function readCgroupInt(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (raw === "max") return null;
    const bytes = parseInt(raw, 10);
    return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Read the memory limit from the VELLUM_MEMORY_LIMIT env var (K8s resource
 * format), then fall back to cgroups, then to os.totalmem() at the call site.
 *
 * In platform mode the container runs under gVisor where cgroup files may report
 * the node's memory rather than the container limit. VELLUM_MEMORY_LIMIT is set
 * by the StatefulSet template to the exact K8s memory limit (e.g. "3Gi").
 */
export function getContainerMemoryLimitBytes(): number | null {
  // 1. Prefer the explicit env var set by the platform StatefulSet template.
  try {
    const envLimit = process.env.VELLUM_MEMORY_LIMIT;
    if (envLimit) {
      const parsed = parseK8sMemoryBytes(envLimit);
      if (parsed !== null) return parsed;
    }
  } catch {
    /* env var parsing failed – fall through to cgroups */
  }

  // 2. Try cgroups v2.
  const v2 = readCgroupInt("/sys/fs/cgroup/memory.max");
  if (v2 !== null) return v2;

  // 3. Try cgroups v1.
  try {
    const raw = readFileSync(
      "/sys/fs/cgroup/memory/memory.limit_in_bytes",
      "utf-8",
    ).trim();
    const bytes = parseInt(raw, 10);
    // cgroups v1 uses a near-INT64_MAX sentinel when no limit is set.
    if (!isNaN(bytes) && bytes > 0 && bytes < totalmem() * 1.5) return bytes;
  } catch {
    /* not available */
  }
  return null;
}

/**
 * Read the container's current memory usage from cgroup files.
 *
 * Tries cgroups v2 (`memory.current`) first, then cgroups v1
 * (`memory/memory.usage_in_bytes`), mirroring the v2-then-v1 fallback used by
 * {@link getContainerMemoryLimitBytes}. Returns null if neither file is
 * available or readable.
 *
 * Unlike the limit lookup, no env-var override is needed: the gVisor issue that
 * motivates VELLUM_MEMORY_LIMIT is specifically about the *limit* files exposing
 * the host node's memory instead of the sandbox limit. The *usage* files
 * (memory.current / memory.usage_in_bytes) reflect the sandbox's own accounting
 * and are accurate under gVisor.
 */
export function getContainerMemoryUsageBytes(): number | null {
  return (
    readCgroupInt("/sys/fs/cgroup/memory.current") ??
    readCgroupInt("/sys/fs/cgroup/memory/memory.usage_in_bytes")
  );
}

/**
 * Read the high-water mark of the container's memory usage.
 *
 * cgroups v2 (`memory.peak`) first, then cgroups v1
 * (`memory/memory.max_usage_in_bytes`). Returns null when neither is available
 * — `memory.peak` in particular only exists on newer kernels, so callers must
 * tolerate its absence.
 */
export function getContainerMemoryPeakBytes(): number | null {
  return (
    readCgroupInt("/sys/fs/cgroup/memory.peak") ??
    readCgroupInt("/sys/fs/cgroup/memory/memory.max_usage_in_bytes")
  );
}

/**
 * Breakdown of the cgroup's memory charge from the cgroup v2 `memory.stat`
 * file. `memory.current` alone hides *what kind* of memory fills the cgroup —
 * anonymous process heap, page cache, and kernel allocations are all charged to
 * the same total but respond to completely different remedies.
 *
 * The derived split is the headline number:
 *
 * - `unevictableBytes` (anon + slab_unreclaimable): memory reclaim cannot
 *   evict. It only shrinks when processes free it or die — growth here is real
 *   pressure heading toward an OOM kill.
 * - `reclaimableBytes` (file + slab_reclaimable): the kernel can drop this
 *   under pressure. A large value is not by itself a problem, but reclaiming it
 *   synchronously is what stalls allocations.
 *
 * Individual fields are null when the kernel doesn't expose them (e.g. the
 * aggregate `kernel` counter only exists on newer kernels). The whole read
 * returns null on cgroups v1 or when the file is unreadable.
 */
export interface ContainerMemoryStat {
  /** Anonymous memory (process heaps/stacks) charged to the cgroup. */
  anonBytes: number | null;
  /** Page cache (file-backed pages) charged to the cgroup. */
  fileBytes: number | null;
  /** Total kernel memory charged to the cgroup (includes slab). */
  kernelBytes: number | null;
  /** Slab memory the kernel can reclaim under pressure (dentries, inodes). */
  slabReclaimableBytes: number | null;
  /** Slab memory pinned until explicitly freed. */
  slabUnreclaimableBytes: number | null;
  /** anon + slab_unreclaimable — reclaim cannot evict this. */
  unevictableBytes: number | null;
  /** file + slab_reclaimable — the kernel can drop this under pressure. */
  reclaimableBytes: number | null;
}

/** Parse `<key> <count>` lines (the memory.stat / memory.events / cpu.stat format). */
export function parseKeyedCounts(raw: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (!key) {
      continue;
    }
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      counts[key] = parsed;
    }
  }
  return counts;
}

/** Parse cgroup v2 `memory.stat` content into the recorded breakdown. */
export function parseMemoryStat(raw: string): ContainerMemoryStat {
  const counts = parseKeyedCounts(raw);

  const anonBytes = counts.anon ?? null;
  const fileBytes = counts.file ?? null;
  const slabReclaimableBytes = counts.slab_reclaimable ?? null;
  const slabUnreclaimableBytes = counts.slab_unreclaimable ?? null;

  return {
    anonBytes,
    fileBytes,
    kernelBytes: counts.kernel ?? null,
    slabReclaimableBytes,
    slabUnreclaimableBytes,
    unevictableBytes:
      anonBytes != null && slabUnreclaimableBytes != null
        ? anonBytes + slabUnreclaimableBytes
        : null,
    reclaimableBytes:
      fileBytes != null && slabReclaimableBytes != null
        ? fileBytes + slabReclaimableBytes
        : null,
  };
}

/**
 * Reclaim / thrash counters from cgroup v2 `memory.stat`. All are cumulative
 * since boot and monotonic:
 *
 * - `pgscanDirect` / `pgstealDirect`: pages scanned / reclaimed *synchronously*
 *   by an allocating process because the cgroup was at its limit. Sustained
 *   growth means allocations are stalling inside the kernel — what looks like a
 *   multi-second GC pause from userspace is usually this.
 * - `workingsetRefaultFile`: previously-evicted file pages faulted back in.
 *   Growth means reclaim is evicting pages that are still needed (cache
 *   thrash), so the page cache is undersized for the working set.
 *
 * Fields are null when the kernel doesn't expose them; the whole read is null
 * on cgroups v1 or when the file is unreadable.
 */
export interface ContainerReclaimCounters {
  pgscanDirect: number | null;
  pgstealDirect: number | null;
  workingsetRefaultFile: number | null;
}

/** Parse cgroup v2 `memory.stat` content into the reclaim/thrash counters. */
export function parseReclaimCounters(raw: string): ContainerReclaimCounters {
  const counts = parseKeyedCounts(raw);
  return {
    pgscanDirect: counts.pgscan_direct ?? null,
    pgstealDirect: counts.pgsteal_direct ?? null,
    workingsetRefaultFile: counts.workingset_refault_file ?? null,
  };
}

/**
 * Raw cgroup v2 `memory.stat` content, or null on cgroups v1 / unreadable.
 * Callers that need both the byte breakdown and the reclaim counters read once
 * and feed the same content to both parsers, so the two views are coherent.
 */
export function readMemoryStatRaw(): string | null {
  try {
    return readFileSync("/sys/fs/cgroup/memory.stat", "utf-8");
  } catch {
    return null;
  }
}

export function getContainerMemoryStat(): ContainerMemoryStat | null {
  const raw = readMemoryStatRaw();
  return raw != null ? parseMemoryStat(raw) : null;
}

/**
 * Pressure counters from the cgroup v2 `memory.events` file. Each field counts
 * how many times the cgroup crossed the corresponding boundary since boot; a
 * rising `max` (usage hit the hard limit and allocation was throttled) or
 * `oom_kill` (a process was reaped) is the clearest in-VM signal that the
 * container is being squeezed toward an OOM kill. Returns null on cgroups v1 or
 * when the file is unreadable.
 */
export interface ContainerMemoryEvents {
  low: number;
  high: number;
  max: number;
  oom: number;
  oomKill: number;
}

export function getContainerMemoryEvents(): ContainerMemoryEvents | null {
  let raw: string;
  try {
    raw = readFileSync("/sys/fs/cgroup/memory.events", "utf-8");
  } catch {
    return null;
  }

  const counts = parseKeyedCounts(raw);

  return {
    low: counts.low ?? 0,
    high: counts.high ?? 0,
    max: counts.max ?? 0,
    oom: counts.oom ?? 0,
    oomKill: counts.oom_kill ?? 0,
  };
}
