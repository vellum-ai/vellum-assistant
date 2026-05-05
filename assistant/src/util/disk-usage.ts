import { spawnSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";

import { getMinikubeStorageSize } from "../config/env-registry.js";
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

export function getDiskUsageInfo(): DiskUsageInfo | null {
  try {
    const wsDir = getWorkspaceDir();
    const diskPath = existsSync(wsDir) ? wsDir : "/";
    const stats = statfsSync(diskPath);
    const fsTotalBytes = stats.bsize * stats.blocks;
    const fsFreeBytes = stats.bsize * stats.bavail;
    const bytesToMb = (b: number) =>
      Math.round((b / (1024 * 1024)) * 100) / 100;

    // Minikube mode: the platform passes the PVC storage size so we can
    // report accurate capacity. On hostPath-backed PVCs statfsSync reports
    // the host's entire filesystem rather than the PVC. Detect this by
    // comparing filesystem size against PVC size — if the filesystem is
    // larger, measure actual directory usage with `du` instead.
    const storageSizeRaw = getMinikubeStorageSize();
    if (storageSizeRaw) {
      const pvcTotalBytes = parseK8sMemoryBytes(storageSizeRaw);
      if (pvcTotalBytes !== null && fsTotalBytes > pvcTotalBytes * 1.1) {
        const volumePaths = [diskPath];
        if (diskPath !== "/data" && existsSync("/data")) {
          volumePaths.push("/data");
        }
        const usedBytes = getCachedDirectorySizeBytes(volumePaths);
        if (usedBytes !== null) {
          return {
            path: diskPath,
            totalMb: bytesToMb(pvcTotalBytes),
            usedMb: bytesToMb(usedBytes),
            freeMb: bytesToMb(Math.max(0, pvcTotalBytes - usedBytes)),
          };
        }
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
