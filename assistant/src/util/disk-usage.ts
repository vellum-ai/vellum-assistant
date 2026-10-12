import { existsSync, statfsSync } from "node:fs";

import { getWorkspaceDir } from "./platform.js";

export interface DiskUsageInfo {
  path: string;
  totalMb: number;
  usedMb: number;
  freeMb: number;
}

/**
 * Report the filesystem containing the workspace using filesystem counters.
 * Docker named volumes and minikube hostPath volumes report the backing
 * filesystem, including usage outside the workspace and its provisioned quota.
 */
export async function getDiskUsageInfo(): Promise<DiskUsageInfo | null> {
  try {
    const wsDir = getWorkspaceDir();
    const diskPath = existsSync(wsDir) ? wsDir : "/";
    const stats = statfsSync(diskPath);
    const fsTotalBytes = stats.bsize * stats.blocks;
    const fsFreeBytes = stats.bsize * stats.bavail;
    const bytesToMb = (b: number) =>
      Math.round((b / (1024 * 1024)) * 100) / 100;

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
  if (!match) {
    return null;
  }
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
  if (mult === undefined) {
    return null;
  }
  const bytes = Math.round(num * mult);
  return bytes > 0 ? bytes : null;
}
