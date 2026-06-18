import { spawnSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";

import {
  getIsContainerized,
  getIsPlatform,
  getMinikubeStorageSize,
} from "../config/env-registry.js";
import { getWorkspaceDir } from "./platform.js";

export interface DiskUsageInfo {
  path: string;
  totalMb: number;
  usedMb: number;
  freeMb: number;
}

/**
 * Measure the on-disk usage of one or more directory paths using `du -sb`.
 * Returns the sum of all paths in bytes, or null on failure.
 */
function getDirectorySizeBytes(paths: string[]): number | null {
  try {
    const existing = paths.filter((p) => existsSync(p));
    if (existing.length === 0) return null;
    const result = spawnSync("du", ["-sb", ...existing], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    if (result.status !== 0) return null;
    let total = 0;
    for (const line of result.stdout.trim().split("\n")) {
      const size = parseInt(line.split("\t")[0], 10);
      if (!isNaN(size) && size > 0) total += size;
    }
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

const DU_CACHE_TTL_MS = 60_000;
let duCacheValue: number | null = null;
let duCacheTime = 0;
let duCachePaths: string | null = null;

function getCachedDirectorySizeBytes(paths: string[]): number | null {
  const key = paths.join("\0");
  const now = Date.now();
  if (duCachePaths === key && now - duCacheTime < DU_CACHE_TTL_MS) {
    return duCacheValue;
  }
  duCacheValue = getDirectorySizeBytes(paths);
  duCacheTime = now;
  duCachePaths = key;
  return duCacheValue;
}

export function __resetDiskUsageCacheForTests(): void {
  duCacheValue = null;
  duCacheTime = 0;
  duCachePaths = null;
}

/**
 * How the workspace volume's capacity should be reported when statfsSync
 * cannot see the volume directly.
 *
 * - `fixed-cap`: minikube hostPath PVC — the PVC request is the hard
 *   capacity, so usage is measured with `du` and free space is whatever
 *   remains within the quota.
 * - `host-free`: local Docker named volume — the volume is backed by the
 *   host (or Colima VM) filesystem and can grow into its free space, so
 *   usage is measured with `du` and the effective capacity is current usage
 *   plus the host's remaining headroom.
 * - `none`: statfsSync already reports the volume accurately (bare metal, or
 *   a platform-managed instance on a CSI-backed PVC), so use it directly.
 */
type WorkspaceVolumeReporting =
  | { kind: "none" }
  | { kind: "fixed-cap"; totalBytes: number }
  | { kind: "host-free" };

/**
 * Decide how to report the workspace volume's capacity. Both minikube
 * hostPath PVCs and local Docker named volumes are backed by the host
 * filesystem, so statfsSync reports the host's entire disk rather than the
 * workspace volume — in both cases we measure actual usage with `du` instead.
 */
function classifyWorkspaceVolume(
  fsTotalBytes: number,
): WorkspaceVolumeReporting {
  // Minikube mode: the platform passes the PVC storage size so we can report
  // accurate capacity. Detect the hostPath case by comparing filesystem size
  // against the PVC size — if the filesystem is larger, statfsSync is seeing
  // the host disk and we should measure the directory instead.
  const storageSizeRaw = getMinikubeStorageSize();
  if (storageSizeRaw) {
    const pvcTotalBytes = parseK8sMemoryBytes(storageSizeRaw);
    if (pvcTotalBytes !== null && fsTotalBytes > pvcTotalBytes * 1.1) {
      return { kind: "fixed-cap", totalBytes: pvcTotalBytes };
    }
    return { kind: "none" };
  }

  // Local Docker hatch: the workspace is a Docker named volume backed by the
  // host filesystem. Platform-managed remote instances run on CSI-backed PVCs
  // where statfsSync already reports the volume, so they are excluded.
  if (getIsContainerized() && !getIsPlatform()) {
    return { kind: "host-free" };
  }

  return { kind: "none" };
}

export function getDiskUsageInfo(): DiskUsageInfo | null {
  try {
    const wsDir = getWorkspaceDir();
    const diskPath = existsSync(wsDir) ? wsDir : "/";
    const stats = statfsSync(diskPath);
    const fsTotalBytes = stats.bsize * stats.blocks;
    const fsFreeBytes = stats.bsize * stats.bavail;
    const bytesToMb = (b: number) =>
      Math.round((b / (1024 * 1024)) * 100) / 100;

    const reporting = classifyWorkspaceVolume(fsTotalBytes);
    if (reporting.kind !== "none") {
      const volumePaths = [diskPath];
      if (diskPath !== "/data" && existsSync("/data")) {
        volumePaths.push("/data");
      }
      const usedBytes = getCachedDirectorySizeBytes(volumePaths);
      if (usedBytes !== null) {
        const totalBytes =
          reporting.kind === "fixed-cap"
            ? reporting.totalBytes
            : usedBytes + fsFreeBytes;
        const freeBytes =
          reporting.kind === "fixed-cap"
            ? Math.max(0, reporting.totalBytes - usedBytes)
            : fsFreeBytes;
        return {
          path: diskPath,
          totalMb: bytesToMb(totalBytes),
          usedMb: bytesToMb(usedBytes),
          freeMb: bytesToMb(freeBytes),
        };
      }
    }

    return {
      path: diskPath,
      totalMb: bytesToMb(fsTotalBytes),
      usedMb: bytesToMb(fsTotalBytes - fsFreeBytes),
      freeMb: bytesToMb(fsFreeBytes),
    };
  } catch {
    return null;
  }
}

/**
 * Parse a Kubernetes-style memory string (e.g. "3Gi", "512Mi", "1G") into bytes.
 * Returns null if the value is not a recognized format.
 */
export function parseK8sMemoryBytes(value: string): number | null {
  const match = value
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E|m)?$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = match[2] ?? "";
  const multipliers: Record<string, number> = {
    "": 1,
    m: 1e-3,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  };
  const mult = multipliers[unit];
  if (mult === undefined) return null;
  const bytes = Math.round(num * mult);
  return bytes > 0 ? bytes : null;
}
