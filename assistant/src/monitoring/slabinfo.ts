/**
 * Kernel slab-cache accounting from `/proc/slabinfo`, for high-memory
 * snapshots. Slab memory (dentries, inodes, fuse_inode, …) is charged to the
 * cgroup but belongs to no process, so per-process RSS accounting can never
 * explain it — hundreds of MB of inode/dentry cache driven by workspace file
 * count are invisible without this view.
 *
 * `/proc/slabinfo` is root-only (mode 0400); reads are best-effort and return
 * null when the file is unreadable (unprivileged process, macOS).
 */

import { readFileSync } from "node:fs";

export interface SlabCache {
  name: string;
  activeObjs: number;
  numObjs: number;
  objSizeBytes: number;
  /** numObjs × objSizeBytes — the memory held by this cache's slabs. */
  totalBytes: number;
}

/**
 * Parse `/proc/slabinfo` (version 2.x) content into per-cache totals, largest
 * first. Header and malformed lines are skipped.
 */
export function parseSlabinfo(raw: string): SlabCache[] {
  const caches: SlabCache[] = [];
  for (const line of raw.split("\n")) {
    // Header lines: "slabinfo - version: 2.1" and the "# name ..." legend.
    if (!line || line.startsWith("#") || line.startsWith("slabinfo")) {
      continue;
    }
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) {
      continue;
    }
    const [name, activeRaw, numRaw, sizeRaw] = fields;
    const activeObjs = parseInt(activeRaw, 10);
    const numObjs = parseInt(numRaw, 10);
    const objSizeBytes = parseInt(sizeRaw, 10);
    if (
      !Number.isFinite(activeObjs) ||
      !Number.isFinite(numObjs) ||
      !Number.isFinite(objSizeBytes)
    ) {
      continue;
    }
    caches.push({
      name,
      activeObjs,
      numObjs,
      objSizeBytes,
      totalBytes: numObjs * objSizeBytes,
    });
  }
  caches.sort((a, b) => b.totalBytes - a.totalBytes);
  return caches;
}

/**
 * The top `limit` slab caches by held memory, largest first. Null when
 * `/proc/slabinfo` is unavailable or unreadable.
 */
export function topSlabCaches(limit: number): SlabCache[] | null {
  let raw: string;
  try {
    raw = readFileSync("/proc/slabinfo", "utf-8");
  } catch {
    return null;
  }
  return parseSlabinfo(raw).slice(0, limit);
}
